/**
 * Fixed product bundles (v4.1 D7, #165).
 *
 * A bundle is an ordinary variant with a FIXED price whose stock is
 * drawn from other variants. "Songkran gift set — 890฿" containing
 * 2 × soap + 1 × candle: the customer pays 890฿ whatever the parts
 * cost, and buying one takes 2 soaps and 1 candle off the shelf.
 *
 * ── Two invariants this module exists to protect ────────────
 *
 * 1. **The bundle's price is authoritative.** Nothing here computes a
 *    bundle price from its components. `totals.ts` sees a bundle line
 *    exactly like any other line — a variant with a price_satang. An
 *    order is an immutable financial record; if a bundle's price were
 *    re-derived at checkout (or worse, at read time on a historical
 *    order) then changing a component's price next month would
 *    silently rewrite what a customer paid in March. The only money
 *    this file knows about is `componentValueSatang`, which is
 *    display-only ("normally 1,050฿") and never reaches an order.
 *
 * 2. **Component reservation is all-or-nothing.** Selling one bundle
 *    must reserve EVERY component atomically. The failure mode being
 *    prevented is concrete: two shoppers race for the last candle,
 *    both bundles reserve their soap successfully, and without
 *    rollback both carts hold soap that neither will buy while one
 *    gets a hard OUT_OF_STOCK on the candle. So
 *    `reserveVariantWithComponents` unwinds every partial reservation
 *    before returning failure. The per-component reserve is the SAME
 *    `UPDATE ... WHERE (on_hand - reserved) >= qty` CAS from
 *    inventory.ts — this module never invents a second stock path,
 *    it only fans one call out into several.
 *
 * ── Recursion ───────────────────────────────────────────────
 *
 * A bundle must not contain a bundle. Enforced at write time in
 * `setBundleComponents` (assertComponentsAreNotBundles) and pinned by
 * bundles.node.test.ts. One level deep by construction means
 * `expandVariantForInventory` is a single query with no fixpoint loop
 * and no cycle detection, and a malicious or fat-fingered
 * A-contains-B-contains-A cannot fan out unboundedly.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  shopBundleComponents,
  shopInventoryItems,
  shopInventoryLevels,
  shopProductLocalizations,
  shopProducts,
  shopProductVariants,
} from "./schema";
import {
  commitVariantSale,
  releaseVariant,
  reserveVariant,
  type ReservationOutcome,
} from "./inventory";
import { ShopValidationError } from "./service";

/**
 * D1 binds at most 100 parameters per statement; the repo chunks at
 * 90 to leave headroom for the statement's own literals.
 */
const BIND_CHUNK = 90;

export function chunk<T>(items: readonly T[], size = BIND_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ─── Pure availability math ─────────────────────────────────

export type ComponentStock = {
  componentVariantId: string;
  /** How many of this component ONE bundle contains. Always >= 1. */
  quantity: number;
  /** Component's available count (on_hand - reserved), or null if untracked. */
  available: number | null;
};

/**
 * How many whole bundles the current component stock can make.
 *
 *     min over components of floor(available / quantityPerBundle)
 *
 * Untracked components (`available: null`) impose no ceiling — they
 * are "unlimited stock, don't fight over it", the same reading
 * inventory.ts's NOT_TRACKED gets.
 *
 * A bundle with NO components is not purchasable (0). That is a
 * misconfigured bundle, and the safe reading of "contains nothing" is
 * "cannot be sold" rather than "infinitely available" — a merchant who
 * flips is_bundle on and hasn't picked parts yet must not start taking
 * orders for an empty box.
 *
 * A bundle whose components are ALL untracked is unlimited, reported
 * here as Infinity; callers clamp for display.
 */
export function bundleAvailability(components: readonly ComponentStock[]): {
  available: number;
  /** Components at zero — what the storefront names as the blocker. */
  limitingComponentIds: string[];
} {
  if (components.length === 0) {
    return { available: 0, limitingComponentIds: [] };
  }

  let available = Infinity;
  for (const c of components) {
    if (c.available === null) continue; // untracked → no ceiling
    if (c.quantity <= 0) continue; // defensive; write path rejects these
    const makeable = Math.floor(c.available / c.quantity);
    if (makeable < available) available = makeable;
  }

  if (available === Infinity) {
    return { available: Infinity, limitingComponentIds: [] };
  }

  const limiting = components
    .filter(
      (c) =>
        c.available !== null &&
        c.quantity > 0 &&
        Math.floor(c.available / c.quantity) === available,
    )
    .map((c) => c.componentVariantId);

  return { available: Math.max(0, available), limitingComponentIds: limiting };
}

/**
 * Display-only "what the parts would cost separately", for the
 * "normally 1,050฿ — save 160฿" line on the product page.
 *
 * NOT a price. Never written to a cart item, an order line, or any
 * total. The bundle's own price_satang is the only number that reaches
 * the books. Integer satang throughout.
 */
export function componentValueSatang(
  components: readonly { quantity: number; priceSatang: number }[],
): number {
  return components.reduce((sum, c) => sum + c.quantity * c.priceSatang, 0);
}

/**
 * Expand a purchase of `bundleQty` bundles into per-component
 * quantities. Pure — the multiplication that the reserve/commit/
 * release paths all share.
 *
 * Duplicate component ids are summed rather than emitted twice, so a
 * caller can never issue two separate reserves against the same
 * variant for one line (which would take two trips through the CAS
 * and could half-succeed).
 */
export function expandQuantities(
  components: readonly { componentVariantId: string; quantity: number }[],
  bundleQty: number,
): Array<{ variantId: string; quantity: number }> {
  if (!Number.isInteger(bundleQty) || bundleQty <= 0) {
    throw new Error(
      `expandQuantities: bundleQty must be a positive integer, got ${bundleQty}`,
    );
  }
  const totals = new Map<string, number>();
  for (const c of components) {
    const add = c.quantity * bundleQty;
    totals.set(
      c.componentVariantId,
      (totals.get(c.componentVariantId) ?? 0) + add,
    );
  }
  return [...totals].map(([variantId, quantity]) => ({ variantId, quantity }));
}

// ─── Reads ──────────────────────────────────────────────────

export type BundleComponentDetail = {
  componentVariantId: string;
  quantity: number;
  position: number;
  variantTitle: string;
  sku: string | null;
  productId: string;
  productSlug: string;
  /**
   * The component's English product title — what a shopper actually
   * recognises. `variantTitle` alone is "Default" or "Red / M", which
   * names nothing on its own in a bundle-contents list.
   */
  productTitle: string;
  priceSatang: number;
  /** null when the component's inventory is untracked. */
  available: number | null;
};

/**
 * Component rows for one bundle variant, hydrated with the variant,
 * product and stock context the storefront and admin both need.
 * Ordered by `position` so the merchant's chosen order is what the
 * customer reads.
 */
export async function getBundleComponents(
  d1: D1Database,
  bundleVariantId: string,
): Promise<BundleComponentDetail[]> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(shopBundleComponents)
    .where(eq(shopBundleComponents.bundleVariantId, bundleVariantId))
    .orderBy(asc(shopBundleComponents.position))
    .all();
  if (rows.length === 0) return [];

  const componentIds = rows.map((r) => r.componentVariantId);
  const variants = await selectVariantsChunked(db, componentIds);
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const productIds = [...new Set(variants.map((v) => v.productId))];
  const products = productIds.length
    ? (
        await Promise.all(
          chunk(productIds).map((ids) =>
            db
              .select()
              .from(shopProducts)
              .where(inArray(shopProducts.id, ids))
              .all(),
          ),
        )
      ).flat()
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));

  const titles = productIds.length
    ? (
        await Promise.all(
          chunk(productIds).map((ids) =>
            db
              .select()
              .from(shopProductLocalizations)
              .where(
                and(
                  inArray(shopProductLocalizations.productId, ids),
                  eq(shopProductLocalizations.locale, "en"),
                ),
              )
              .all(),
          ),
        )
      ).flat()
    : [];
  const titleByProduct = new Map(titles.map((l) => [l.productId, l.title]));

  const stock = await componentStockMap(d1, componentIds);

  return rows.map((r) => {
    const v = variantById.get(r.componentVariantId);
    const p = v ? productById.get(v.productId) : null;
    return {
      componentVariantId: r.componentVariantId,
      quantity: r.quantity,
      position: r.position,
      variantTitle: v?.titleCached ?? "",
      sku: v?.sku ?? null,
      productId: v?.productId ?? "",
      productSlug: p?.slug ?? "",
      productTitle: (p ? titleByProduct.get(p.id) : null) ?? p?.slug ?? "",
      priceSatang: v?.priceSatang ?? 0,
      available: stock.get(r.componentVariantId) ?? null,
    };
  });
}

/**
 * Purchasable quantity for a bundle variant, straight from its
 * components' live stock. Returns `null` when the variant is not a
 * bundle at all, so callers can fall through to ordinary variant
 * availability rather than guessing.
 */
export async function getBundleAvailability(
  d1: D1Database,
  bundleVariantId: string,
): Promise<number | null> {
  const rows = await loadComponentRows(d1, bundleVariantId);
  if (rows.length === 0) return null;
  const stock = await componentStockMap(
    d1,
    rows.map((r) => r.componentVariantId),
  );
  const { available } = bundleAvailability(
    rows.map((r) => ({
      componentVariantId: r.componentVariantId,
      quantity: r.quantity,
      available: stock.get(r.componentVariantId) ?? null,
    })),
  );
  return available === Infinity ? Number.MAX_SAFE_INTEGER : available;
}

/**
 * True when this variant has component rows (i.e. it is a bundle).
 * Keyed on the component rows rather than `shop_products.is_bundle` so
 * a half-configured product (flag on, no parts picked) never routes
 * through the expansion path with an empty component list.
 */
export async function isBundleVariant(
  d1: D1Database,
  variantId: string,
): Promise<boolean> {
  const rows = await loadComponentRows(d1, variantId);
  return rows.length > 0;
}

// ─── Inventory expansion ────────────────────────────────────

/**
 * Resolve one variant into the set of (variantId, quantity) pairs that
 * a sale of `qty` of it actually moves.
 *
 *   - Ordinary variant → `[{ variantId, quantity: qty }]` (identity).
 *   - Bundle variant   → one entry per component, `componentQty × qty`.
 *
 * Single level, no recursion: components are guaranteed non-bundles by
 * the write path, so there is nothing to descend into.
 */
export async function expandVariantForInventory(
  d1: D1Database,
  variantId: string,
  qty: number,
): Promise<Array<{ variantId: string; quantity: number }>> {
  const rows = await loadComponentRows(d1, variantId);
  if (rows.length === 0) return [{ variantId, quantity: qty }];
  return expandQuantities(rows, qty);
}

/**
 * Bundle-aware `reserveVariant`. Drop-in for the plain one: an
 * ordinary variant takes exactly the old path.
 *
 * For a bundle, every component is reserved through the same CAS, and
 * **any failure rolls back every component already reserved in this
 * call**. This is the single most important property in the feature —
 * without the unwind, a bundle that fails on its last component leaves
 * the earlier components reserved to a cart that will never check out,
 * and those units are invisible-but-unsellable until the 15-minute
 * sweep. Worse, under contention two racing bundles can deadlock each
 * other into both failing while holding each other's stock.
 *
 * NOT_TRACKED components are skipped (nothing to reserve) without
 * failing the bundle, matching how startCheckout treats untracked
 * lines. A bundle whose components are all untracked therefore
 * succeeds with no reservation at all.
 */
export async function reserveVariantWithComponents(
  d1: D1Database,
  variantId: string,
  qty: number,
): Promise<ReservationOutcome> {
  const parts = await expandVariantForInventory(d1, variantId, qty);

  // Identity case — no bundle involved, no rollback bookkeeping.
  if (parts.length === 1 && parts[0].variantId === variantId) {
    return reserveVariant(d1, variantId, qty);
  }

  const reserved: Array<{ variantId: string; quantity: number }> = [];
  for (const part of parts) {
    let outcome: ReservationOutcome;
    try {
      outcome = await reserveVariant(d1, part.variantId, part.quantity);
    } catch (err) {
      await rollback(d1, reserved);
      throw err;
    }
    if (!outcome.ok) {
      // Untracked / missing-inventory components hold no stock, so
      // they neither block the bundle nor need unwinding.
      if (outcome.reason === "NOT_TRACKED") continue;
      await rollback(d1, reserved);
      return outcome;
    }
    reserved.push(part);
  }

  if (reserved.length === 0) {
    // Every component untracked → nothing reserved, but the sale is
    // allowed. Report NOT_TRACKED so the caller records a ledger row
    // without a matching stock hold, exactly as it does for a plain
    // untracked variant.
    return { ok: false, reason: "NOT_TRACKED" };
  }

  // Counters describe the bundle, not any one component: how many
  // bundles are now claimed, and how many the shelf can still make.
  const remaining = await getBundleAvailability(d1, variantId);
  return {
    ok: true,
    onHand:
      remaining === null ? 0 : Math.min(remaining, Number.MAX_SAFE_INTEGER),
    reserved: qty,
  };
}

/** Bundle-aware `releaseVariant` — gives back exactly what was taken. */
export async function releaseVariantWithComponents(
  d1: D1Database,
  variantId: string,
  qty: number,
): Promise<void> {
  const parts = await expandVariantForInventory(d1, variantId, qty);
  for (const part of parts) {
    try {
      await releaseVariant(d1, part.variantId, part.quantity);
    } catch {
      // Untracked or deleted component — releaseVariant throws only
      // when there is no inventory row to give back to, which means
      // nothing was ever held. Same best-effort contract the sweep
      // and the cancel path already use.
    }
  }
}

/** Bundle-aware `commitVariantSale` — decrements every component. */
export async function commitVariantSaleWithComponents(
  d1: D1Database,
  variantId: string,
  qty: number,
): Promise<void> {
  const parts = await expandVariantForInventory(d1, variantId, qty);
  for (const part of parts) {
    await commitVariantSale(d1, part.variantId, part.quantity);
  }
}

async function rollback(
  d1: D1Database,
  reserved: ReadonlyArray<{ variantId: string; quantity: number }>,
): Promise<void> {
  for (const back of reserved) {
    try {
      await releaseVariant(d1, back.variantId, back.quantity);
    } catch {
      /* best-effort unwind, matching startCheckout's rollback */
    }
  }
}

// ─── Writes ─────────────────────────────────────────────────

export type BundleComponentInput = {
  componentVariantId: string;
  quantity: number;
};

/**
 * Replace a bundle variant's component list wholesale.
 *
 * Validation, in the order a merchant hits it:
 *   - every quantity is a positive integer
 *   - no duplicate component (the PK would reject it anyway; caught
 *     here so the merchant gets a sentence, not a UNIQUE violation)
 *   - the bundle cannot contain itself
 *   - no component may belong to a bundle product (recursion guard)
 *   - every component variant must exist
 *
 * Passing an empty list clears the components. That leaves the bundle
 * unpurchasable (bundleAvailability returns 0), which is the correct
 * resting state for a bundle whose parts are being reconsidered.
 */
export async function setBundleComponents(
  d1: D1Database,
  bundleVariantId: string,
  components: readonly BundleComponentInput[],
): Promise<void> {
  const db = drizzle(d1);

  for (const c of components) {
    if (!Number.isInteger(c.quantity) || c.quantity <= 0) {
      throw new ShopValidationError(
        `Bundle component quantity must be a positive integer, got ${c.quantity}`,
        "quantity",
      );
    }
    if (c.componentVariantId === bundleVariantId) {
      throw new ShopValidationError(
        "A bundle cannot contain itself",
        "componentVariantId",
      );
    }
  }

  const ids = components.map((c) => c.componentVariantId);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new ShopValidationError(
      "Each component may appear only once — raise its quantity instead",
      "componentVariantId",
    );
  }

  if (ids.length > 0) {
    await assertComponentsAreNotBundles(d1, ids);
  }

  await db
    .delete(shopBundleComponents)
    .where(eq(shopBundleComponents.bundleVariantId, bundleVariantId));

  if (components.length === 0) return;

  // 4 binds per row → chunk well inside D1's 100-bind ceiling.
  const rows = components.map((c, i) => ({
    bundleVariantId,
    componentVariantId: c.componentVariantId,
    quantity: c.quantity,
    position: i,
  }));
  for (const part of chunk(rows, 20)) {
    await db.insert(shopBundleComponents).values(part);
  }
}

/**
 * The recursion guard. Rejects any component that is itself a bundle —
 * either by its product carrying `is_bundle`, or by it already having
 * component rows of its own (belt and braces: a product whose flag was
 * cleared but whose component rows linger must still not be nestable).
 *
 * Also rejects components that do not exist, so a stale variant id
 * from a long-open admin tab fails loudly instead of silently
 * producing a bundle that can never be reserved.
 */
export async function assertComponentsAreNotBundles(
  d1: D1Database,
  componentVariantIds: readonly string[],
): Promise<void> {
  const db = drizzle(d1);
  const ids = [...new Set(componentVariantIds)];
  if (ids.length === 0) return;

  const variants = await selectVariantsChunked(db, ids);
  const found = new Set(variants.map((v) => v.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ShopValidationError(
      `Unknown component variant: ${missing.join(", ")}`,
      "componentVariantId",
    );
  }

  const productIds = [...new Set(variants.map((v) => v.productId))];
  const bundleProducts = (
    await Promise.all(
      chunk(productIds).map((part) =>
        db
          .select()
          .from(shopProducts)
          .where(
            and(
              inArray(shopProducts.id, part),
              eq(shopProducts.isBundle, true),
            ),
          )
          .all(),
      ),
    )
  ).flat();
  const bundleProductIds = new Set(bundleProducts.map((p) => p.id));

  const nestedByFlag = variants.filter((v) =>
    bundleProductIds.has(v.productId),
  );
  if (nestedByFlag.length > 0) {
    throw new ShopValidationError(
      `A bundle cannot contain another bundle: ${nestedByFlag
        .map((v) => v.id)
        .join(", ")}`,
      "componentVariantId",
    );
  }

  const nestedByRows = (
    await Promise.all(
      chunk(ids).map((part) =>
        db
          .select()
          .from(shopBundleComponents)
          .where(inArray(shopBundleComponents.bundleVariantId, part))
          .all(),
      ),
    )
  ).flat();
  if (nestedByRows.length > 0) {
    throw new ShopValidationError(
      `A bundle cannot contain another bundle: ${[
        ...new Set(nestedByRows.map((r) => r.bundleVariantId)),
      ].join(", ")}`,
      "componentVariantId",
    );
  }
}

// ─── Internals ──────────────────────────────────────────────

async function loadComponentRows(
  d1: D1Database,
  bundleVariantId: string,
): Promise<Array<{ componentVariantId: string; quantity: number }>> {
  const db = drizzle(d1);
  return db
    .select({
      componentVariantId: shopBundleComponents.componentVariantId,
      quantity: shopBundleComponents.quantity,
    })
    .from(shopBundleComponents)
    .where(eq(shopBundleComponents.bundleVariantId, bundleVariantId))
    .orderBy(asc(shopBundleComponents.position))
    .all();
}

function selectVariantsChunked(
  db: ReturnType<typeof drizzle>,
  ids: readonly string[],
): Promise<Array<typeof shopProductVariants.$inferSelect>> {
  return Promise.all(
    chunk(ids).map((part) =>
      db
        .select()
        .from(shopProductVariants)
        .where(inArray(shopProductVariants.id, part))
        .all(),
    ),
  ).then((parts) => parts.flat());
}

/**
 * available (= on_hand - reserved) per variant, or absent from the map
 * when the variant is untracked or has no inventory rows — both of
 * which mean "imposes no ceiling on the bundle".
 */
async function componentStockMap(
  d1: D1Database,
  variantIds: readonly string[],
): Promise<Map<string, number>> {
  const db = drizzle(d1);
  const out = new Map<string, number>();
  if (variantIds.length === 0) return out;

  const items = (
    await Promise.all(
      chunk(variantIds).map((part) =>
        db
          .select()
          .from(shopInventoryItems)
          .where(inArray(shopInventoryItems.variantId, part))
          .all(),
      ),
    )
  ).flat();
  const tracked = items.filter(
    (i) => i.tracked && !i.continueSellingWhenOutOfStock,
  );
  if (tracked.length === 0) return out;

  const levels = (
    await Promise.all(
      chunk(tracked.map((i) => i.id)).map((part) =>
        db
          .select()
          .from(shopInventoryLevels)
          .where(
            and(
              inArray(shopInventoryLevels.itemId, part),
              eq(shopInventoryLevels.locationId, "default"),
            ),
          )
          .all(),
      ),
    )
  ).flat();
  const levelByItem = new Map(levels.map((l) => [l.itemId, l]));

  for (const item of tracked) {
    const level = levelByItem.get(item.id);
    if (!level) continue;
    out.set(item.variantId, Math.max(0, level.onHand - level.reserved));
  }
  return out;
}
