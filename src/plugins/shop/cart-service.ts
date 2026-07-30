/**
 * Cart service — session-cookie-scoped, wired to inventory reservation
 * primitives. Called by:
 *   - POST /api/shop/cart/items — add/update/remove line items
 *   - POST /api/shop/cart/checkout/start — flip cart to
 *     checkout_started + reserve inventory for 15 minutes
 *   - Scheduled Worker cron — sweep expired reservations
 *
 * Design decisions:
 *
 * 1. **One "open" cart per session at a time** (enforced by the
 *    UNIQUE index on (session_id, status)). If a customer signs in
 *    mid-cart, the sessionId rotates; the cart_carts.previousSessionId
 *    column is set so a second browser tab of the same guest doesn't
 *    lose items on refresh.
 *
 * 2. **Price snapshot on cart_items** — a variant price change while
 *    the customer is shopping shows the new price at checkout as a
 *    delta line, not silently rewrites the cart.
 *
 * 3. **Reservation happens at checkout-start, not add-to-cart** —
 *    reserving on add would let stalled carts starve honest buyers.
 *    Add-to-cart is O(1) and doesn't touch inventory. Reserve happens
 *    when the customer commits to a payment intent.
 *
 * 4. **Reject-not-retry on race**. If two carts start checkout for the
 *    same last unit, exactly one succeeds; the other gets a clean
 *    OUT_OF_STOCK line-level error. Never sleep-and-retry.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  shopProducts,
  shopProductLocalizations,
  shopProductVariants,
  shopInventoryItems,
  shopInventoryLevels,
} from "./schema";
import {
  shopCarts,
  shopCartItems,
  shopInventoryReservations,
  type ShopCart,
  type ShopCartItem,
  type ShopCartItemWithContext,
} from "./schema-cart";
import { reserveVariant, releaseVariant } from "./inventory";
import { ShopValidationError } from "./service";

// ─── Constants ──────────────────────────────────────────────

/** 15 minutes in milliseconds — the reservation TTL from checkout-start. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

/** 30 days in milliseconds — cart abandonment threshold. */
export const CART_ABANDONMENT_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Errors ─────────────────────────────────────────────────

export class CartError extends Error {
  readonly code = "CART_ERROR";
  constructor(
    message: string,
    public readonly reason:
      | "CART_NOT_FOUND"
      | "CART_LOCKED"
      | "VARIANT_UNAVAILABLE"
      | "OUT_OF_STOCK"
      | "MAX_QUANTITY_EXCEEDED",
    public readonly cartItemId?: string,
  ) {
    super(message);
    this.name = "CartError";
  }
}

// ─── Service ────────────────────────────────────────────────

export class CartService {
  private db: ReturnType<typeof drizzle>;

  constructor(private readonly d1: D1Database) {
    this.db = drizzle(d1);
  }

  private nowIso() {
    return new Date().toISOString();
  }

  /**
   * Get the open cart for a session, creating one lazily. Idempotent
   * — safe to call on every request. If a `userId` is supplied and
   * the cart's userId is null (guest), upgrades the cart to the user.
   */
  async ensureCart(input: {
    sessionId: string;
    userId?: string | null;
  }): Promise<ShopCart> {
    const existing = await this.db
      .select()
      .from(shopCarts)
      .where(
        and(
          eq(shopCarts.sessionId, input.sessionId),
          eq(shopCarts.status, "open"),
        ),
      )
      .limit(1)
      .get();
    if (existing) {
      if (input.userId && !existing.userId) {
        await this.db
          .update(shopCarts)
          .set({ userId: input.userId, updatedAt: this.nowIso() })
          .where(eq(shopCarts.id, existing.id));
        return { ...existing, userId: input.userId };
      }
      return existing;
    }

    const id = nanoid();
    const now = this.nowIso();
    const row = {
      id,
      userId: input.userId ?? null,
      sessionId: input.sessionId,
      previousSessionId: null,
      email: null,
      status: "open" as const,
      checkoutStartedAt: null,
      discountCode: null,
      recoveryEmailSentAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(shopCarts).values(row);
    return row;
  }

  /**
   * List cart items with the context needed to render the cart UI:
   * variant title, product slug, current price (for delta detection),
   * available stock.
   */
  async listCartItems(cartId: string): Promise<ShopCartItemWithContext[]> {
    const items = await this.db
      .select()
      .from(shopCartItems)
      .where(eq(shopCartItems.cartId, cartId))
      .all();
    if (items.length === 0) return [];

    const variantIds = items.map((i) => i.variantId);

    const variants = await this.db
      .select()
      .from(shopProductVariants)
      .where(inArray(shopProductVariants.id, variantIds))
      .all();
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const productIds = Array.from(new Set(variants.map((v) => v.productId)));
    const products = await this.db
      .select()
      .from(shopProducts)
      .where(inArray(shopProducts.id, productIds))
      .all();
    const productById = new Map(products.map((p) => [p.id, p]));

    const locs = await this.db
      .select()
      .from(shopProductLocalizations)
      .where(
        and(
          inArray(shopProductLocalizations.productId, productIds),
          eq(shopProductLocalizations.locale, "en"),
        ),
      )
      .all();
    const enTitleByProduct = new Map(locs.map((l) => [l.productId, l.title]));

    const inventoryItems = await this.db
      .select()
      .from(shopInventoryItems)
      .where(inArray(shopInventoryItems.variantId, variantIds))
      .all();
    const itemByVariant = new Map(inventoryItems.map((i) => [i.variantId, i]));

    const levels = inventoryItems.length
      ? await this.db
          .select()
          .from(shopInventoryLevels)
          .where(
            inArray(
              shopInventoryLevels.itemId,
              inventoryItems.map((i) => i.id),
            ),
          )
          .all()
      : [];
    const levelByItem = new Map(levels.map((l) => [l.itemId, l]));

    return items.map((ci) => {
      const v = variantById.get(ci.variantId);
      const p = v ? productById.get(v.productId) : null;
      const invItem = itemByVariant.get(ci.variantId);
      const level = invItem ? levelByItem.get(invItem.id) : null;
      const available = level ? Math.max(0, level.onHand - level.reserved) : 0;
      return {
        ...ci,
        variantTitle: v?.titleCached ?? "",
        productSlug: p?.slug ?? "",
        productTitle: p ? (enTitleByProduct.get(p.id) ?? p.slug) : "",
        currentPriceSatang: v?.priceSatang ?? ci.priceSatangAtAdd,
        availableStock: available,
        mediaId: v?.mediaId ?? p?.featuredMediaId ?? null,
      };
    });
  }

  /**
   * Add or update a line item. If the (cart, variant) combination
   * already exists, quantities add (not replace) — matches Shopify's
   * addToCart semantics. To set an exact quantity, use setQuantity().
   */
  async addItem(input: {
    cartId: string;
    variantId: string;
    quantity: number;
  }): Promise<ShopCartItem> {
    if (input.quantity <= 0 || !Number.isInteger(input.quantity)) {
      throw new ShopValidationError(
        `quantity must be a positive integer, got ${input.quantity}`,
        "quantity",
      );
    }
    if (input.quantity > 999) {
      throw new CartError(
        "Quantity per line item is capped at 999",
        "MAX_QUANTITY_EXCEEDED",
      );
    }

    const cart = await this.db
      .select()
      .from(shopCarts)
      .where(eq(shopCarts.id, input.cartId))
      .limit(1)
      .get();
    if (!cart) throw new CartError("Cart not found", "CART_NOT_FOUND");
    if (cart.status !== "open") {
      throw new CartError(
        `Cart is ${cart.status} — add items to a new cart instead`,
        "CART_LOCKED",
      );
    }

    const variant = await this.db
      .select()
      .from(shopProductVariants)
      .where(eq(shopProductVariants.id, input.variantId))
      .limit(1)
      .get();
    if (!variant || variant.status !== "active") {
      throw new CartError(
        `Variant ${input.variantId} is unavailable`,
        "VARIANT_UNAVAILABLE",
      );
    }

    // Deduplicate: existing line for this variant gets its quantity
    // bumped rather than a second row inserted.
    const existing = await this.db
      .select()
      .from(shopCartItems)
      .where(
        and(
          eq(shopCartItems.cartId, input.cartId),
          eq(shopCartItems.variantId, input.variantId),
        ),
      )
      .limit(1)
      .get();

    const now = this.nowIso();
    if (existing) {
      const newQty = existing.quantity + input.quantity;
      if (newQty > 999) {
        throw new CartError(
          "Quantity per line item is capped at 999",
          "MAX_QUANTITY_EXCEEDED",
        );
      }
      await this.db
        .update(shopCartItems)
        .set({ quantity: newQty })
        .where(eq(shopCartItems.id, existing.id));
      await this.db
        .update(shopCarts)
        .set({ updatedAt: now })
        .where(eq(shopCarts.id, cart.id));
      return { ...existing, quantity: newQty };
    }

    const row: ShopCartItem = {
      id: nanoid(),
      cartId: input.cartId,
      variantId: input.variantId,
      quantity: input.quantity,
      priceSatangAtAdd: variant.priceSatang,
      addedAt: now,
    };
    await this.db.insert(shopCartItems).values(row);
    await this.db
      .update(shopCarts)
      .set({ updatedAt: now })
      .where(eq(shopCarts.id, cart.id));
    return row;
  }

  async setQuantity(input: {
    cartId: string;
    cartItemId: string;
    quantity: number;
  }): Promise<ShopCartItem | null> {
    if (input.quantity < 0 || !Number.isInteger(input.quantity)) {
      throw new ShopValidationError(
        `quantity must be a non-negative integer, got ${input.quantity}`,
        "quantity",
      );
    }
    if (input.quantity === 0) {
      await this.removeItem({
        cartId: input.cartId,
        cartItemId: input.cartItemId,
      });
      return null;
    }
    if (input.quantity > 999) {
      throw new CartError(
        "Quantity per line item is capped at 999",
        "MAX_QUANTITY_EXCEEDED",
      );
    }
    await this.db
      .update(shopCartItems)
      .set({ quantity: input.quantity })
      .where(
        and(
          eq(shopCartItems.id, input.cartItemId),
          eq(shopCartItems.cartId, input.cartId),
        ),
      );
    await this.db
      .update(shopCarts)
      .set({ updatedAt: this.nowIso() })
      .where(eq(shopCarts.id, input.cartId));
    const row = await this.db
      .select()
      .from(shopCartItems)
      .where(eq(shopCartItems.id, input.cartItemId))
      .limit(1)
      .get();
    return row ?? null;
  }

  async removeItem(input: {
    cartId: string;
    cartItemId: string;
  }): Promise<void> {
    await this.db
      .delete(shopCartItems)
      .where(
        and(
          eq(shopCartItems.id, input.cartItemId),
          eq(shopCartItems.cartId, input.cartId),
        ),
      );
    await this.db
      .update(shopCarts)
      .set({ updatedAt: this.nowIso() })
      .where(eq(shopCarts.id, input.cartId));
  }

  /**
   * Flip an open cart to `checkout_started` and reserve inventory
   * for every line for 15 minutes. Atomic per-line: if any reserve
   * fails, all previously-reserved lines in this call are released.
   *
   * Returns the reservation records so the checkout page can display
   * "Reservation expires in 14:52" countdowns.
   */
  async startCheckout(input: { cartId: string; email: string }): Promise<{
    cart: ShopCart;
    reservations: Array<{
      cartItemId: string;
      variantId: string;
      quantity: number;
      expiresAt: string;
    }>;
  }> {
    const cart = await this.db
      .select()
      .from(shopCarts)
      .where(eq(shopCarts.id, input.cartId))
      .limit(1)
      .get();
    if (!cart) throw new CartError("Cart not found", "CART_NOT_FOUND");
    if (cart.status !== "open") {
      throw new CartError(`Cart is already ${cart.status}`, "CART_LOCKED");
    }

    const items = await this.db
      .select()
      .from(shopCartItems)
      .where(eq(shopCartItems.cartId, input.cartId))
      .all();
    if (items.length === 0) {
      throw new ShopValidationError("Cart is empty", "cart");
    }

    // Try to reserve every line. Track successes so we can roll back
    // on the first failure — atomic-per-cart even though the underlying
    // reserves are per-line.
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + RESERVATION_TTL_MS,
    ).toISOString();
    const reservationInserts: Array<{
      id: string;
      cartItemId: string;
      variantId: string;
      quantity: number;
      reservedAt: string;
      expiresAt: string;
      releasedAt: null;
      releaseReason: null;
    }> = [];
    const rolledBack: Array<{ variantId: string; quantity: number }> = [];

    try {
      for (const item of items) {
        const outcome = await reserveVariant(
          this.d1,
          item.variantId,
          item.quantity,
        );
        if (!outcome.ok) {
          if (outcome.reason === "NOT_TRACKED") {
            // Untracked stock: no reservation needed, but still record
            // the ledger row so accounting downstream is uniform.
            reservationInserts.push({
              id: nanoid(),
              cartItemId: item.id,
              variantId: item.variantId,
              quantity: item.quantity,
              reservedAt: now.toISOString(),
              expiresAt,
              releasedAt: null,
              releaseReason: null,
            });
            continue;
          }
          throw new CartError(
            `Line ${item.id} could not be reserved: ${outcome.reason}`,
            "OUT_OF_STOCK",
            item.id,
          );
        }
        rolledBack.push({
          variantId: item.variantId,
          quantity: item.quantity,
        });
        reservationInserts.push({
          id: nanoid(),
          cartItemId: item.id,
          variantId: item.variantId,
          quantity: item.quantity,
          reservedAt: now.toISOString(),
          expiresAt,
          releasedAt: null,
          releaseReason: null,
        });
      }
    } catch (err) {
      for (const back of rolledBack) {
        try {
          await releaseVariant(this.d1, back.variantId, back.quantity);
        } catch {
          /* best-effort rollback */
        }
      }
      throw err;
    }

    // Persist the ledger + flip the cart status. Sequential is fine
    // (single Worker request); a full D1 batch is a v3.2 refinement
    // if this becomes a hot path.
    await this.db.insert(shopInventoryReservations).values(reservationInserts);
    await this.db
      .update(shopCarts)
      .set({
        status: "checkout_started",
        email: input.email,
        checkoutStartedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .where(eq(shopCarts.id, input.cartId));

    return {
      cart: {
        ...cart,
        status: "checkout_started",
        email: input.email,
        checkoutStartedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      reservations: reservationInserts.map((r) => ({
        cartItemId: r.cartItemId,
        variantId: r.variantId,
        quantity: r.quantity,
        expiresAt: r.expiresAt,
      })),
    };
  }

  /**
   * Sweep expired reservations. Called by the scheduled Worker cron
   * every minute. Returns the number of reservations released.
   *
   * A reservation is expired when:
   *   - `released_at IS NULL` (still active)
   *   - `expires_at < now`
   *
   * The sweep calls releaseVariant() for each row, then marks the
   * ledger row with release_reason='expired' and releasedAt=now.
   *
   * Idempotent — a second sweep in the same window is a no-op.
   */
  async sweepExpiredReservations(now: Date = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    const expired = await this.db
      .select()
      .from(shopInventoryReservations)
      .where(
        and(
          isNull(shopInventoryReservations.releasedAt),
          lt(shopInventoryReservations.expiresAt, nowIso),
        ),
      )
      .all();

    let released = 0;
    for (const r of expired) {
      try {
        await releaseVariant(this.d1, r.variantId, r.quantity);
        released++;
      } catch {
        // Reservation refers to a deleted variant — skip, mark ledger
        // as released anyway so we don't retry forever.
      }
      await this.db
        .update(shopInventoryReservations)
        .set({ releasedAt: nowIso, releaseReason: "expired" })
        .where(eq(shopInventoryReservations.id, r.id));
    }

    // Also flip carts whose checkout_started is older than the TTL to
    // 'expired' status so a re-visit from the same session starts a
    // fresh cart. Cart items are preserved for one refresh so the
    // customer can see what they lost.
    const cutoff = new Date(now.getTime() - RESERVATION_TTL_MS).toISOString();
    await this.db
      .update(shopCarts)
      .set({ status: "expired", updatedAt: nowIso })
      .where(
        and(
          eq(shopCarts.status, "checkout_started"),
          lt(shopCarts.checkoutStartedAt, cutoff),
        ),
      );

    return released;
  }

  /**
   * Sweep 30-day-old open carts to `abandoned`. Called by the same
   * cron. Cart_items are NOT deleted — the abandoned-cart email flow
   * in v3.4 walks these to build the recovery URL.
   */
  async sweepAbandonedCarts(now: Date = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - CART_ABANDONMENT_MS).toISOString();
    const result = await this.d1
      .prepare(
        `UPDATE shop_carts
         SET status = 'abandoned', updated_at = ?1
         WHERE status = 'open' AND updated_at < ?2`,
      )
      .bind(nowIso, cutoff)
      .run();
    return (result.meta as { changes?: number })?.changes ?? 0;
  }

  /**
   * v3.5: identify open carts eligible for a recovery email — 24h
   * idle, has captured email, has items, hasn't been emailed yet.
   * Returns the cart contexts so the caller (typically the cron
   * endpoint) can fire the emails and update recoveryEmailSentAt.
   *
   * Excludes carts already flipped to abandoned by
   * sweepAbandonedCarts (those are past the recovery window — a
   * 30-day-old cart is unlikely to convert on a nudge).
   */
  async listCartsForRecoveryEmail(
    now: Date = new Date(),
    idleWindowMs = 24 * 60 * 60 * 1000,
  ): Promise<
    Array<{
      cartId: string;
      sessionId: string;
      email: string;
      items: ShopCartItemWithContext[];
      subtotalSatang: number;
    }>
  > {
    const cutoff = new Date(now.getTime() - idleWindowMs).toISOString();
    // Candidates: open carts, updated before cutoff, with an email set,
    // never emailed. Ceiling: 50 per sweep — an operator with many
    // stale carts avoids a single-tick Resend burst.
    const rows = await this.db
      .select()
      .from(shopCarts)
      .where(
        and(
          eq(shopCarts.status, "open"),
          isNull(shopCarts.recoveryEmailSentAt),
          lt(shopCarts.updatedAt, cutoff),
        ),
      )
      .limit(50)
      .all();

    const eligible: Array<{
      cartId: string;
      sessionId: string;
      email: string;
      items: ShopCartItemWithContext[];
      subtotalSatang: number;
    }> = [];
    for (const cart of rows) {
      if (!cart.email) continue;
      const items = await this.listCartItems(cart.id);
      if (items.length === 0) continue;
      const subtotal = items.reduce(
        (sum, i) => sum + i.priceSatangAtAdd * i.quantity,
        0,
      );
      eligible.push({
        cartId: cart.id,
        sessionId: cart.sessionId,
        email: cart.email,
        items,
        subtotalSatang: subtotal,
      });
    }
    return eligible;
  }

  /** Mark a cart's recovery email as sent so the sweep skips it next tick. */
  async markRecoveryEmailSent(
    cartId: string,
    sentAt: Date = new Date(),
  ): Promise<void> {
    await this.db
      .update(shopCarts)
      .set({ recoveryEmailSentAt: sentAt.toISOString() })
      .where(eq(shopCarts.id, cartId));
  }
}
