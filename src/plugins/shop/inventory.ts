/**
 * Inventory reservation primitives.
 *
 * These are the concurrency-safe helpers the v3.2 cart/checkout flow
 * will call. Reservations are held for 15 minutes from checkout-start;
 * expired reservations get swept by a scheduled Worker cron
 * (also ships in v3.2). Ledger table (shop_inventory_reservations)
 * also lands in v3.2 — this module ships the D1-level reserve/release
 * atomically so the API contract is stable ahead of time.
 *
 * Design rationale (design-review must-fix from #56):
 *
 *   - **Reject-not-retry** on concurrent purchases. Two carts race for
 *     the last unit → one succeeds, the other gets OUT_OF_STOCK
 *     immediately. Never sleep-and-retry (a queue would form; UX
 *     degrades under load).
 *   - **`UPDATE ... WHERE available >= qty` with change count check**.
 *     D1's single-writer semantics make this atomic without app-level
 *     locking. If `changes === 0`, someone else got there first.
 *   - **`continueSellingWhenOutOfStock`**: pre-orders + made-to-order
 *     bypass the stock check. Reserved counter still bumps so the
 *     admin can see how many pre-orders are outstanding.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import {
  shopInventoryItems,
  shopInventoryLevels,
} from "./schema";

export type ReservationOutcome =
  | { ok: true; onHand: number; reserved: number }
  | { ok: false; reason: "OUT_OF_STOCK" | "NOT_TRACKED" | "NO_INVENTORY" };

/**
 * Reserve `qty` units of a variant at the default location.
 *
 * Success: onHand unchanged, reserved += qty. Returns the new counts.
 * Failure: no change, returns `{ok: false, reason}`. Callers should
 * treat OUT_OF_STOCK as terminal for this cart line (surface a message,
 * don't retry).
 *
 * If the variant's inventory item has `continueSellingWhenOutOfStock`,
 * the reserve always succeeds — even into negative available. This
 * matches Shopify's `inventoryPolicy: CONTINUE` semantics.
 *
 * NOT_TRACKED means the item exists but tracking is off — the caller
 * should treat this as "unlimited stock, don't fight over it" and
 * skip reservation entirely. NO_INVENTORY means the variant has no
 * inventory_items row at all (misconfigured product).
 */
export async function reserveVariant(
  d1: D1Database,
  variantId: string,
  qty: number,
): Promise<ReservationOutcome> {
  if (qty <= 0 || !Number.isInteger(qty)) {
    throw new Error(`reserveVariant: qty must be a positive integer, got ${qty}`);
  }

  const db = drizzle(d1);

  const item = await db
    .select()
    .from(shopInventoryItems)
    .where(eq(shopInventoryItems.variantId, variantId))
    .limit(1)
    .get();
  if (!item) return { ok: false, reason: "NO_INVENTORY" };
  if (!item.tracked) return { ok: false, reason: "NOT_TRACKED" };

  // Continue-selling variants: bump reserved unconditionally.
  // RETURNING gives us the post-update counts atomically in the same
  // statement — no race where a follow-up SELECT sees a different
  // increment from a concurrent reserver.
  if (item.continueSellingWhenOutOfStock) {
    const rows = await d1
      .prepare(
        `UPDATE shop_inventory_levels
         SET reserved = reserved + ?1
         WHERE item_id = ?2 AND location_id = 'default'
         RETURNING on_hand AS onHand, reserved`,
      )
      .bind(qty, item.id)
      .all<{ onHand: number; reserved: number }>();
    const after = rows.results?.[0];
    if (!after) return { ok: false, reason: "NO_INVENTORY" };
    return { ok: true, onHand: after.onHand, reserved: after.reserved };
  }

  // Standard path: atomic conditional update. D1 serializes writes to
  // a single instance (SQLite semantics), so this UPDATE is atomic
  // without any app-level lock. The WHERE clause is the gate:
  //   available = on_hand - reserved
  //   Only apply the +qty if available >= qty
  // If two carts race for the last unit, exactly one WHERE evaluates
  // true; the other's RETURNING is empty → OUT_OF_STOCK.
  // Using RETURNING (not a follow-up SELECT) so the returned counts
  // reflect *this* reserver's post-state, not whatever a concurrent
  // reserver's update landed after.
  const rows = await d1
    .prepare(
      `UPDATE shop_inventory_levels
       SET reserved = reserved + ?1
       WHERE item_id = ?2
         AND location_id = 'default'
         AND (on_hand - reserved) >= ?1
       RETURNING on_hand AS onHand, reserved`,
    )
    .bind(qty, item.id)
    .all<{ onHand: number; reserved: number }>();

  const after = rows.results?.[0];
  if (!after) return { ok: false, reason: "OUT_OF_STOCK" };
  return { ok: true, onHand: after.onHand, reserved: after.reserved };
}

/**
 * Release `qty` reserved units of a variant (undo a reserveVariant).
 *
 * Called when: (a) the cart is abandoned and the sweep cron cleans up,
 * (b) payment fails and the checkout backs out, (c) a customer removes
 * a line from their cart mid-checkout.
 *
 * Guards against reserved going below 0. If the requested release is
 * larger than current reserved, releases whatever's there (idempotent —
 * safe to call twice without corrupting the counter).
 */
export async function releaseVariant(
  d1: D1Database,
  variantId: string,
  qty: number,
): Promise<{ onHand: number; reserved: number }> {
  if (qty <= 0 || !Number.isInteger(qty)) {
    throw new Error(`releaseVariant: qty must be a positive integer, got ${qty}`);
  }

  const db = drizzle(d1);
  const item = await db
    .select()
    .from(shopInventoryItems)
    .where(eq(shopInventoryItems.variantId, variantId))
    .limit(1)
    .get();
  if (!item) throw new Error(`No inventory item for variant ${variantId}`);

  // Clamp: max(reserved - qty, 0). RETURNING gives us the atomic
  // post-state so a concurrent reserver's update doesn't skew the
  // reported counts.
  const rows = await d1
    .prepare(
      `UPDATE shop_inventory_levels
       SET reserved = MAX(reserved - ?1, 0)
       WHERE item_id = ?2 AND location_id = 'default'
       RETURNING on_hand AS onHand, reserved`,
    )
    .bind(qty, item.id)
    .all<{ onHand: number; reserved: number }>();
  const after = rows.results?.[0];
  if (!after) throw new Error(`No inventory level for variant ${variantId}`);
  return { onHand: after.onHand, reserved: after.reserved };
}

/**
 * Commit a reservation to a sale: on_hand -= qty AND reserved -= qty.
 * Called on payment success. Net effect: stock leaves the store,
 * reservation slot freed up (so the "available" number stays truthful).
 *
 * Uses conditional UPDATE with `on_hand >= qty AND reserved >= qty`
 * to guard against races (although payment success shouldn't race
 * with anything, the belt-and-braces is cheap).
 */
export async function commitVariantSale(
  d1: D1Database,
  variantId: string,
  qty: number,
): Promise<{ onHand: number; reserved: number }> {
  if (qty <= 0 || !Number.isInteger(qty)) {
    throw new Error(
      `commitVariantSale: qty must be a positive integer, got ${qty}`,
    );
  }
  const db = drizzle(d1);
  const item = await db
    .select()
    .from(shopInventoryItems)
    .where(eq(shopInventoryItems.variantId, variantId))
    .limit(1)
    .get();
  if (!item) throw new Error(`No inventory item for variant ${variantId}`);

  // Read pre-state so we can log accounting divergence (reserved
  // clamped means the reservation was mismatched — books off).
  const pre = await db
    .select()
    .from(shopInventoryLevels)
    .where(
      and(
        eq(shopInventoryLevels.itemId, item.id),
        eq(shopInventoryLevels.locationId, "default"),
      ),
    )
    .limit(1)
    .get();
  if (pre) {
    if (pre.onHand < qty) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.inventory] commitVariantSale silently clamps on_hand for variant ${variantId}: on_hand=${pre.onHand}, qty=${qty}`,
      );
    }
    if (pre.reserved < qty) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.inventory] commitVariantSale silently clamps reserved for variant ${variantId}: reserved=${pre.reserved}, qty=${qty}. Books likely off — reservation may have been double-released.`,
      );
    }
  }

  const rows = await d1
    .prepare(
      `UPDATE shop_inventory_levels
       SET on_hand = MAX(on_hand - ?1, 0),
           reserved = MAX(reserved - ?1, 0)
       WHERE item_id = ?2 AND location_id = 'default'
       RETURNING on_hand AS onHand, reserved`,
    )
    .bind(qty, item.id)
    .all<{ onHand: number; reserved: number }>();
  const after = rows.results?.[0];
  if (!after) throw new Error(`No inventory level for variant ${variantId}`);
  return { onHand: after.onHand, reserved: after.reserved };
}
