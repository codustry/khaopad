/**
 * Order service — lifecycle management for orders.
 *
 * Flow:
 *   1. Customer starts checkout → cart flips to checkout_started,
 *      inventory reserved (in cart-service.ts).
 *   2. Customer selects payment method → order created (this service,
 *      status='pending'), Beam charge created, redirected to payment.
 *   3. Beam webhook fires → order status flips to 'paid', inventory
 *      committed via commitVariantSale(), receipt email sent.
 *   4. Admin fulfils → status='fulfilled'. Customer receives shipment.
 *   5. Admin marks delivered → status='delivered'.
 *   6. Admin issues refund → order_adjustments row + provider refund
 *      + status='refunded'.
 *
 * Order snapshots (title/sku/price on shop_order_items) ensure the
 * receipt survives variant deletion + product edits. Design-review
 * must-fix from #56.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { shopProductVariants } from "./schema";
import {
  shopCarts,
  shopCartItems,
  shopInventoryReservations,
  shopOrders,
  shopOrderItems,
  shopOrderAdjustments,
  type ShopOrder,
  type ShopOrderItem,
} from "./schema-cart";
import { commitVariantSale, releaseVariant } from "./inventory";
import { ShopValidationError } from "./service";

// ─── Types ──────────────────────────────────────────────────

export type OrderAddress = {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode: string;
  countryCode: string; // ISO-3166 alpha-2
  phone?: string | null;
};

export type CreateOrderFromCartInput = {
  cartId: string;
  email: string;
  providerName: string;
  shippingAddress?: OrderAddress | null;
  billingAddress?: OrderAddress | null;
  shippingSatang?: number;
  taxSatang?: number;
  discountSatang?: number;
  discountCodeSnapshot?: string | null;
};

export type OrderWithItems = ShopOrder & {
  items: ShopOrderItem[];
  adjustments: Array<{
    id: string;
    kind: string;
    amountSatang: number;
    reason: string | null;
    createdAt: string;
  }>;
};

// ─── Order-number generation ────────────────────────────────

/**
 * Generate a human-readable order number `KHP-YYYY-NNNNN`.
 *
 * Uses `MAX(order_number)` + parse-sequence-suffix + increment, not
 * `COUNT(*)` — which was buggy under concurrent creates because two
 * writers could both read count=N before either committed, and both
 * try to insert `KHP-YYYY-(N+1)`. The MAX approach still races (two
 * writers both see same max), but the UNIQUE constraint on
 * `shop_orders.order_number` + the caller's retry loop breaks the
 * tie deterministically: the losing writer re-reads the fresh MAX
 * (which now includes the winner's row), gets a strictly higher
 * suffix, and succeeds.
 *
 * For high volume (>1 order/sec sustained), replace with a sequence
 * row updated via `UPDATE ... RETURNING new_value`. Small-shop scale
 * is well-served by this.
 */
async function nextOrderNumber(d1: D1Database, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  const prefix = `KHP-${year}-`;
  const db = drizzle(d1);
  const rows = await db
    .select({ maxNumber: sql<string | null>`MAX(order_number)` })
    .from(shopOrders)
    .where(sql`${shopOrders.orderNumber} LIKE ${prefix + "%"}`)
    .all();
  const maxNumber = rows[0]?.maxNumber ?? null;
  let nextSeq = 1;
  if (maxNumber) {
    // Parse "KHP-YYYY-NNNNN" → NNNNN
    const suffix = maxNumber.slice(prefix.length);
    const parsed = Number.parseInt(suffix, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      nextSeq = parsed + 1;
    }
  }
  return `${prefix}${String(nextSeq).padStart(5, "0")}`;
}

// ─── Service ────────────────────────────────────────────────

export class OrderService {
  private db: ReturnType<typeof drizzle>;

  constructor(private readonly d1: D1Database) {
    this.db = drizzle(d1);
  }

  private nowIso() {
    return new Date().toISOString();
  }

  /**
   * Create a pending order from a cart that's already in
   * `checkout_started` state (inventory reserved). This does NOT
   * charge the payment provider — the caller passes the charge id
   * once the provider returns it.
   *
   * Returns the order id. Cart is not yet flipped to `ordered` —
   * that happens on payment success in `markPaid()`.
   */
  async createFromCart(
    input: CreateOrderFromCartInput,
  ): Promise<{ orderId: string; orderNumber: string }> {
    const cart = await this.db
      .select()
      .from(shopCarts)
      .where(eq(shopCarts.id, input.cartId))
      .limit(1)
      .get();
    if (!cart) throw new ShopValidationError("Cart not found", "cartId");
    if (cart.status !== "checkout_started") {
      throw new ShopValidationError(
        `Cart must be in checkout_started state (found: ${cart.status})`,
        "cart.status",
      );
    }

    const items = await this.db
      .select()
      .from(shopCartItems)
      .where(eq(shopCartItems.cartId, cart.id))
      .all();
    if (items.length === 0) {
      throw new ShopValidationError("Cart has no items", "cart");
    }

    // Snapshot variant details for the order line items.
    const variantIds = items.map((i) => i.variantId);
    const variants = await this.db
      .select()
      .from(shopProductVariants)
      .where(inArray(shopProductVariants.id, variantIds))
      .all();
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const subtotalSatang = items.reduce(
      (sum, item) => sum + item.priceSatangAtAdd * item.quantity,
      0,
    );
    const shippingSatang = input.shippingSatang ?? 0;
    const taxSatang = input.taxSatang ?? 0;
    const discountSatang = input.discountSatang ?? 0;
    const totalSatang = Math.max(
      0,
      subtotalSatang + shippingSatang + taxSatang - discountSatang,
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const orderId = nanoid();

    // Race-tolerant order number generation.
    let orderNumber = await nextOrderNumber(this.d1, now);
    let attempts = 0;
    while (attempts < 5) {
      try {
        await this.db.insert(shopOrders).values({
          id: orderId,
          orderNumber,
          userId: cart.userId,
          email: input.email,
          status: "pending",
          providerName: input.providerName,
          providerChargeId: null,
          subtotalSatang,
          shippingSatang,
          taxSatang,
          discountSatang,
          totalSatang,
          shippingAddressJson: input.shippingAddress
            ? JSON.stringify(input.shippingAddress)
            : null,
          billingAddressJson: input.billingAddress
            ? JSON.stringify(input.billingAddress)
            : null,
          discountCodeSnapshot: input.discountCodeSnapshot ?? null,
          createdAt: nowIso,
          updatedAt: nowIso,
          paidAt: null,
          fulfilledAt: null,
          deliveredAt: null,
          refundedAt: null,
          cancelledAt: null,
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") && msg.includes("order_number")) {
          attempts++;
          orderNumber = await nextOrderNumber(this.d1, now);
          continue;
        }
        throw err;
      }
    }
    if (attempts >= 5) {
      throw new ShopValidationError(
        "Could not allocate a unique order number after 5 attempts",
        "orderNumber",
      );
    }

    // Insert order items (snapshot title/sku/price at this moment).
    const orderItemRows = items.map((item) => {
      const variant = variantById.get(item.variantId);
      if (!variant) {
        throw new ShopValidationError(
          `Variant ${item.variantId} no longer exists`,
          "variantId",
        );
      }
      const lineSubtotal = item.priceSatangAtAdd * item.quantity;
      return {
        id: nanoid(),
        orderId,
        variantId: item.variantId,
        quantity: item.quantity,
        titleSnapshot: variant.titleCached || "Default",
        skuSnapshot: variant.sku,
        priceSnapshotSatang: item.priceSatangAtAdd,
        lineSubtotalSatang: lineSubtotal,
        lineTaxSatang: 0, // Per-line tax computation ships with the tax service (3f-h).
      };
    });
    await this.db.insert(shopOrderItems).values(orderItemRows);

    return { orderId, orderNumber };
  }

  /**
   * Attach the provider's charge id to a pending order. Called after
   * `provider.createCharge()` returns a chargeId.
   */
  async attachProviderCharge(input: {
    orderId: string;
    providerChargeId: string;
  }): Promise<void> {
    await this.db
      .update(shopOrders)
      .set({
        providerChargeId: input.providerChargeId,
        updatedAt: this.nowIso(),
      })
      .where(eq(shopOrders.id, input.orderId));
  }

  /**
   * Flip a pending order to paid. Commits inventory (moves stock from
   * reserved → sold), flips cart to `ordered`, marks reservation
   * ledger rows as `committed`. Called from the webhook handler on
   * provider success.
   */
  async markPaid(input: {
    orderId: string;
    providerChargeId: string;
  }): Promise<OrderWithItems> {
    const nowIso = this.nowIso();

    // Atomic state-transition guard: only the ONE writer that flips
    // pending → paid proceeds to commit inventory. Concurrent webhook
    // retries see changes=0 and short-circuit as a no-op (idempotent).
    // Fixes double-inventory-decrement race from post-merge bug hunt.
    const flipResult = await this.d1
      .prepare(
        `UPDATE shop_orders
         SET status = 'paid',
             provider_charge_id = ?1,
             paid_at = ?2,
             updated_at = ?2
         WHERE id = ?3 AND status = 'pending'`,
      )
      .bind(input.providerChargeId, nowIso, input.orderId)
      .run();

    const flipped = (flipResult.meta as { changes?: number })?.changes ?? 0;

    const order = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, input.orderId))
      .limit(1)
      .get();
    if (!order) throw new ShopValidationError("Order not found", "orderId");

    if (flipped === 0) {
      // Idempotent no-op path. Already paid → return hydrated state.
      // Any other terminal status (cancelled/refunded) → log + no-op
      // rather than throw, so a late webhook doesn't blow up the
      // handler (fixes MINOR #14 from bug hunt).
      if (order.status !== "paid") {
        // eslint-disable-next-line no-console
        console.warn(
          `[shop.order] markPaid: order ${order.orderNumber} already in terminal status '${order.status}', ignoring late webhook`,
        );
      }
      return this.hydrate(order);
    }

    // We won the transition — commit inventory + finalize side effects.
    const items = await this.db
      .select()
      .from(shopOrderItems)
      .where(eq(shopOrderItems.orderId, order.id))
      .all();

    for (const item of items) {
      try {
        await commitVariantSale(this.d1, item.variantId, item.quantity);
      } catch (err) {
        // Customer already charged — never fail a paid order over
        // inventory bookkeeping. Log and continue.
        // eslint-disable-next-line no-console
        console.error(
          `[shop.order] commitVariantSale failed for order ${order.orderNumber} variant ${item.variantId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Mark reservation ledger rows for THIS order's cart as committed.
    // Fixes email-scope bug — was previously matching every cart with
    // the same email (historical purchases got their ledger rewritten).
    // Uses variantId + qty to identify likely reservations; the sweep
    // cron already handles rows that don't match.
    const variantQtyPairs = items.map((i) => ({
      variantId: i.variantId,
      quantity: i.quantity,
    }));
    if (variantQtyPairs.length > 0) {
      const activeReservationIds = await this.db
        .select()
        .from(shopInventoryReservations)
        .where(
          and(
            inArray(
              shopInventoryReservations.variantId,
              variantQtyPairs.map((p) => p.variantId),
            ),
            isNull(shopInventoryReservations.releasedAt),
          ),
        )
        .all();
      const idsToRelease: string[] = [];
      const needByVariant = new Map<string, number>();
      for (const p of variantQtyPairs) {
        needByVariant.set(
          p.variantId,
          (needByVariant.get(p.variantId) ?? 0) + p.quantity,
        );
      }
      for (const r of activeReservationIds) {
        if (r.releasedAt) continue;
        const need = needByVariant.get(r.variantId) ?? 0;
        if (need <= 0) continue;
        idsToRelease.push(r.id);
        needByVariant.set(r.variantId, need - r.quantity);
      }
      if (idsToRelease.length > 0) {
        await this.db
          .update(shopInventoryReservations)
          .set({ releasedAt: nowIso, releaseReason: "committed" })
          .where(inArray(shopInventoryReservations.id, idsToRelease));
      }
    }

    // Flip cart(s) matching this order's email + checkout_started
    // status. Multiple carts with same email is rare; scoping tightly
    // to checkout_started avoids touching already-ordered carts.
    //
    // Per-cart, with the same supersede-by-rename treatment as
    // startCheckout and the sweep (#154): `shop_carts` is UNIQUE on
    // (session_id, status), so a returning customer whose session
    // already owns an `ordered` cart from a previous purchase would
    // make a bulk flip violate the index — INSIDE the payment webhook,
    // after inventory has committed. The order would be paid in the DB
    // while the webhook 500s and Beam retries against the idempotent
    // flip guard. Tombstoning the OLD ordered cart first (it is
    // history; the fresh purchase should own the live `ordered` slot)
    // keeps this flip collision-free.
    const cartsToFlip = await this.db
      .select({
        id: shopCarts.id,
        sessionId: shopCarts.sessionId,
      })
      .from(shopCarts)
      .where(
        and(
          eq(shopCarts.email, order.email),
          eq(shopCarts.status, "checkout_started"),
        ),
      );
    for (const cart of cartsToFlip) {
      const priorOrdered = await this.db
        .select({
          id: shopCarts.id,
          previousSessionId: shopCarts.previousSessionId,
          sessionId: shopCarts.sessionId,
        })
        .from(shopCarts)
        .where(
          and(
            eq(shopCarts.sessionId, cart.sessionId),
            eq(shopCarts.status, "ordered"),
          ),
        )
        .limit(1)
        .get();
      if (priorOrdered) {
        await this.db
          .update(shopCarts)
          .set({
            sessionId: `superseded:${priorOrdered.id}`,
            previousSessionId:
              priorOrdered.previousSessionId ?? priorOrdered.sessionId,
            updatedAt: nowIso,
          })
          .where(eq(shopCarts.id, priorOrdered.id));
      }
      await this.db
        .update(shopCarts)
        .set({ status: "ordered", updatedAt: nowIso })
        .where(eq(shopCarts.id, cart.id));
    }

    return this.hydrate({
      ...order,
      status: "paid",
      providerChargeId: input.providerChargeId,
      paidAt: nowIso,
      updatedAt: nowIso,
    });
  }

  /**
   * Payment failed / cancelled — release reservations, mark order
   * cancelled. Idempotent.
   */
  async markCancelled(input: { orderId: string }): Promise<void> {
    const order = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, input.orderId))
      .limit(1)
      .get();
    if (!order) return;
    if (order.status === "cancelled" || order.status === "refunded") return;

    const items = await this.db
      .select()
      .from(shopOrderItems)
      .where(eq(shopOrderItems.orderId, order.id))
      .all();

    for (const item of items) {
      try {
        await releaseVariant(this.d1, item.variantId, item.quantity);
      } catch {
        /* variant may be gone */
      }
    }

    const nowIso = this.nowIso();
    await this.db
      .update(shopOrders)
      .set({
        status: "cancelled",
        cancelledAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(shopOrders.id, order.id));
  }

  /**
   * Record a refund (partial or full) — creates an order_adjustments
   * row + flips order status when the total refunded reaches the
   * order total. Does NOT call the provider — the caller does that
   * (so refund attempts can fail cleanly without a stale DB row).
   */
  async recordRefund(input: {
    orderId: string;
    amountSatang: number;
    reason?: string;
    createdBy?: string;
    kind: "refund_full" | "refund_partial";
  }): Promise<void> {
    const nowIso = this.nowIso();
    await this.db.insert(shopOrderAdjustments).values({
      id: nanoid(),
      orderId: input.orderId,
      kind: input.kind,
      amountSatang: -Math.abs(input.amountSatang), // refunds are negative
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: nowIso,
    });
    if (input.kind === "refund_full") {
      await this.db
        .update(shopOrders)
        .set({
          status: "refunded",
          refundedAt: nowIso,
          updatedAt: nowIso,
        })
        .where(eq(shopOrders.id, input.orderId));
    }
  }

  /**
   * Flip a paid order to fulfilled. Called from the admin dashboard.
   */
  async markFulfilled(orderId: string): Promise<void> {
    const nowIso = this.nowIso();
    await this.db
      .update(shopOrders)
      .set({ status: "fulfilled", fulfilledAt: nowIso, updatedAt: nowIso })
      .where(and(eq(shopOrders.id, orderId), eq(shopOrders.status, "paid")));
  }

  async markDelivered(orderId: string): Promise<void> {
    const nowIso = this.nowIso();
    await this.db
      .update(shopOrders)
      .set({ status: "delivered", deliveredAt: nowIso, updatedAt: nowIso })
      .where(
        and(eq(shopOrders.id, orderId), eq(shopOrders.status, "fulfilled")),
      );
  }

  // ── Queries ─────────────────────────────────────────────

  async getOrder(orderId: string): Promise<OrderWithItems | null> {
    const row = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, orderId))
      .limit(1)
      .get();
    return row ? this.hydrate(row) : null;
  }

  async getOrderByNumber(
    orderNumber: string,
    email?: string,
  ): Promise<OrderWithItems | null> {
    const conditions = email
      ? and(
          eq(shopOrders.orderNumber, orderNumber),
          eq(shopOrders.email, email),
        )
      : eq(shopOrders.orderNumber, orderNumber);
    const row = await this.db
      .select()
      .from(shopOrders)
      .where(conditions)
      .limit(1)
      .get();
    return row ? this.hydrate(row) : null;
  }

  async listOrders(
    opts: {
      status?: ShopOrder["status"];
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ShopOrder[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    return opts.status
      ? this.db
          .select()
          .from(shopOrders)
          .where(eq(shopOrders.status, opts.status))
          .orderBy(sql`${shopOrders.createdAt} DESC`)
          .limit(limit)
          .offset(offset)
          .all()
      : this.db
          .select()
          .from(shopOrders)
          .orderBy(sql`${shopOrders.createdAt} DESC`)
          .limit(limit)
          .offset(offset)
          .all();
  }

  private async hydrate(order: ShopOrder): Promise<OrderWithItems> {
    const [items, adjustments] = await Promise.all([
      this.db
        .select()
        .from(shopOrderItems)
        .where(eq(shopOrderItems.orderId, order.id))
        .all(),
      this.db
        .select()
        .from(shopOrderAdjustments)
        .where(eq(shopOrderAdjustments.orderId, order.id))
        .all(),
    ]);
    return {
      ...order,
      items,
      adjustments: adjustments.map((a) => ({
        id: a.id,
        kind: a.kind,
        amountSatang: a.amountSatang,
        reason: a.reason,
        createdAt: a.createdAt,
      })),
    };
  }
}
