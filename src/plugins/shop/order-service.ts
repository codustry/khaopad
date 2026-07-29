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
import { and, eq, inArray, sql } from "drizzle-orm";
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
import {
  commitVariantSale,
  releaseVariant,
} from "./inventory";
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
 * Uses a per-year sequence lookup. Not race-safe under concurrent
 * order creation (two orders in the same second could get the same
 * number) — the UNIQUE constraint on shop_orders.order_number acts
 * as the tiebreaker; caller catches the collision and retries with
 * a fresh count. For a small-shop deployment (< 1 order/second) this
 * is fine; for high volume, switch to a sequence table or ULID-based
 * timestamped id.
 */
async function nextOrderNumber(d1: D1Database, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  const prefix = `KHP-${year}-`;
  const db = drizzle(d1);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(shopOrders)
    .where(sql`${shopOrders.orderNumber} LIKE ${prefix + "%"}`)
    .all();
  const count = rows[0]?.count ?? 0;
  return `${prefix}${String(count + 1).padStart(5, "0")}`;
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
    const order = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, input.orderId))
      .limit(1)
      .get();
    if (!order) throw new ShopValidationError("Order not found", "orderId");
    if (order.status !== "pending") {
      // Idempotent: paid → paid is a no-op (webhook can fire twice).
      if (order.status === "paid") {
        return this.hydrate(order);
      }
      throw new ShopValidationError(
        `Order ${order.orderNumber} is ${order.status}, cannot mark paid`,
        "order.status",
      );
    }

    const items = await this.db
      .select()
      .from(shopOrderItems)
      .where(eq(shopOrderItems.orderId, order.id))
      .all();

    // Commit each variant's stock (on_hand -= qty, reserved -= qty).
    // Fires our silent-clamp telemetry from inventory.ts if books are off.
    for (const item of items) {
      try {
        await commitVariantSale(this.d1, item.variantId, item.quantity);
      } catch (err) {
        // Never fail a paid order over inventory bookkeeping — customer
        // has already been charged. Log the drift and continue.
        // eslint-disable-next-line no-console
        console.error(
          `[shop.order] commitVariantSale failed for order ${order.orderNumber} variant ${item.variantId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Mark reservation ledger rows as committed.
    const cartItemIds = await this.db
      .select({ id: shopCartItems.id })
      .from(shopCartItems)
      .innerJoin(shopCarts, eq(shopCarts.id, shopCartItems.cartId))
      .where(eq(shopCarts.email, order.email))
      .all();
    if (cartItemIds.length > 0) {
      await this.db
        .update(shopInventoryReservations)
        .set({
          releasedAt: this.nowIso(),
          releaseReason: "committed",
        })
        .where(
          inArray(
            shopInventoryReservations.cartItemId,
            cartItemIds.map((c) => c.id),
          ),
        );
    }

    // Flip cart to ordered (find by matching provider charge or email).
    const nowIso = this.nowIso();
    await this.db
      .update(shopCarts)
      .set({ status: "ordered", updatedAt: nowIso })
      .where(
        and(
          eq(shopCarts.email, order.email),
          eq(shopCarts.status, "checkout_started"),
        ),
      );

    await this.db
      .update(shopOrders)
      .set({
        status: "paid",
        providerChargeId: input.providerChargeId,
        paidAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(shopOrders.id, order.id));

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

  async listOrders(opts: {
    status?: ShopOrder["status"];
    limit?: number;
    offset?: number;
  } = {}): Promise<ShopOrder[]> {
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
