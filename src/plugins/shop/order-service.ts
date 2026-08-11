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
 *
 * v3.14 (#109/#110/#113):
 *   - Order status is three orthogonal axes (financial / fulfillment /
 *     return). The legacy `status` column is DERIVED on every write
 *     via `deriveLegacyStatus()` so pre-Phase-C reads keep working.
 *   - Refund totals derive from the shop_order_adjustments ledger
 *     (append-only, idempotency-keyed) — never a mutated counter.
 *   - Lifecycle transitions emit domain events (order.created,
 *     order.paid, order.fulfilled, order.delivered, order.cancelled,
 *     order.refunded) through an injected emitter — routes wire it to
 *     the core webhook dispatcher; tests stub it.
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
import { allocateDiscount } from "./totals";

// ─── Types ──────────────────────────────────────────────────

export type OrderFinancialStatus =
  | "pending"
  | "paid"
  | "partially_refunded"
  | "refunded"
  | "cancelled";

export type OrderFulfillmentStatus = "unfulfilled" | "fulfilled" | "delivered";

export type OrderReturnStatus =
  | null
  | "requested"
  | "approved"
  | "received"
  | "resolved";

/**
 * Emitter for shop domain events (#113). The service never imports the
 * webhook dispatcher directly — routes inject one wired to
 * `dispatchEvent(locals.content, ...)`; tests inject a recorder.
 * Best-effort by contract: implementations must never throw into the
 * order write path (the service also guards with try/catch).
 */
export type OrderEventEmitter = (
  event: string,
  payload: Record<string, unknown>,
) => void;

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
  /**
   * True when the discount is a free-shipping code. The discount then
   * belongs to the SHIPPING charge, not the goods — allocating it across
   * goods lines would understate their refundable value and under-refund
   * returns on free-shipping orders (totals.ts makes the same split).
   */
  discountIsFreeShipping?: boolean;
  discountCodeSnapshot?: string | null;
  // Sales channel — defaults to 'online_store'. Phase E adds
  // 'tonbab_pos' / 'marketplace' callers.
  channel?: string;
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

// ─── Legacy status derivation (#109) ────────────────────────

/**
 * Collapse the (financial, fulfillment) axes back into the legacy
 * single-axis `status`. Pure — the legacy column is written from this
 * on every transition and NEVER written directly, so pre-Phase-C
 * reads (funnel pages, admin lists, status endpoint) stay consistent.
 *
 * Mapping (inverse of migration 0025's backfill):
 *   cancelled/*                    → cancelled
 *   refunded/*                     → refunded
 *   pending/*                      → pending
 *   paid|partially_refunded × unfulfilled → paid
 *   paid|partially_refunded × fulfilled   → fulfilled
 *   paid|partially_refunded × delivered   → delivered
 * (Legacy has no partial-refund notion — a partially refunded order
 * keeps presenting its fulfillment progress, matching pre-#110
 * behavior where partial refunds never touched `status`.)
 */
export function deriveLegacyStatus(
  financial: OrderFinancialStatus,
  fulfillment: OrderFulfillmentStatus,
): ShopOrder["status"] {
  switch (financial) {
    case "cancelled":
      return "cancelled";
    case "refunded":
      return "refunded";
    case "pending":
      return "pending";
    case "paid":
    case "partially_refunded":
      switch (fulfillment) {
        case "delivered":
          return "delivered";
        case "fulfilled":
          return "fulfilled";
        default:
          return "paid";
      }
  }
}

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
  private emitEvent: OrderEventEmitter | null;

  constructor(
    private readonly d1: D1Database,
    opts: { emitEvent?: OrderEventEmitter } = {},
  ) {
    this.db = drizzle(d1);
    this.emitEvent = opts.emitEvent ?? null;
  }

  private nowIso() {
    return new Date().toISOString();
  }

  /**
   * Fire a domain event through the injected emitter. Best-effort by
   * design — an event failure must never fail the order write that
   * triggered it (#113: dispatcher is already fire-and-forget; this
   * catch covers a throwing emitter implementation).
   */
  private emit(event: string, payload: Record<string, unknown>): void {
    if (!this.emitEvent) return;
    try {
      this.emitEvent(event, payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[shop.order] event emitter failed for '${event}':`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Canonical event payload (#113): order identity, the three status
   * axes + derived legacy status, totals, channel. Deliberately NO
   * customer PII — core article events carry only {id, slug}, and the
   * order events match that convention (no email, no addresses).
   */
  private eventPayload(order: ShopOrder): Record<string, unknown> {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      channel: order.channel,
      status: order.status,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      returnStatus: order.returnStatus,
      subtotalSatang: order.subtotalSatang,
      shippingSatang: order.shippingSatang,
      taxSatang: order.taxSatang,
      discountSatang: order.discountSatang,
      totalSatang: order.totalSatang,
      currency: "THB",
    };
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
          // Legacy axis derived; the three real axes start at their
          // zero states (#109).
          status: deriveLegacyStatus("pending", "unfulfilled"),
          financialStatus: "pending",
          fulfillmentStatus: "unfulfilled",
          returnStatus: null,
          channel: input.channel ?? "online_store",
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
    // #108/B6: allocate the order-level goods discount across lines
    // (largest-remainder over line subtotals — same pure function the
    // totals engine uses, so Σ line allocations === the goods portion
    // of discount_satang exactly). Refund/return math reads the
    // allocated amount, never the raw line price.
    const allocations = new Map(
      allocateDiscount(
        items.map((item) => ({
          id: item.id,
          amountSatang: item.priceSatangAtAdd * item.quantity,
        })),
        // Free-shipping discounts belong to the shipping charge — goods
        // lines get zero allocation, mirroring computeTotals' split.
        input.discountIsFreeShipping ? 0 : discountSatang,
      ).map((a) => [a.id, a.discountAllocatedSatang]),
    );
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
        discountAllocatedSatang: allocations.get(item.id) ?? 0,
      };
    });
    await this.db.insert(shopOrderItems).values(orderItemRows);

    const created = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, orderId))
      .limit(1)
      .get();
    if (created) this.emit("order.created", this.eventPayload(created));

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
    // #109: the CAS predicate lives on the financial axis now; the
    // legacy `status` is written as its derivation (paid+unfulfilled →
    // 'paid') in the same statement so the two can never diverge.
    const flipResult = await this.d1
      .prepare(
        `UPDATE shop_orders
         SET status = 'paid',
             financial_status = 'paid',
             provider_charge_id = ?1,
             paid_at = ?2,
             updated_at = ?2
         WHERE id = ?3 AND financial_status = 'pending'`,
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

    const paidOrder: ShopOrder = {
      ...order,
      status: "paid",
      financialStatus: "paid",
      providerChargeId: input.providerChargeId,
      paidAt: nowIso,
      updatedAt: nowIso,
    };
    // Winner-only emission — the CAS guard above means retries never
    // re-fire order.paid.
    this.emit("order.paid", this.eventPayload(paidOrder));

    return this.hydrate(paidOrder);
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
    // #109: guard on the financial axis (mirrors the old legacy-status
    // guard — cancelled/refunded orders are terminal for this path).
    if (
      order.financialStatus === "cancelled" ||
      order.financialStatus === "refunded"
    ) {
      return;
    }

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
        status: deriveLegacyStatus("cancelled", order.fulfillmentStatus),
        financialStatus: "cancelled",
        cancelledAt: nowIso,
        updatedAt: nowIso,
      })
      .where(eq(shopOrders.id, order.id));

    this.emit(
      "order.cancelled",
      this.eventPayload({
        ...order,
        status: "cancelled",
        financialStatus: "cancelled",
        cancelledAt: nowIso,
        updatedAt: nowIso,
      }),
    );
  }

  /**
   * Sum of prior refunds for an order, in POSITIVE satang, derived by
   * summing the adjustments ledger (#110) — the ledger is the source
   * of truth; nothing ever mutates a refunded counter.
   */
  async refundedTotalSatang(orderId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<
          number | null
        >`SUM(ABS(${shopOrderAdjustments.amountSatang}))`,
      })
      .from(shopOrderAdjustments)
      .where(
        and(
          eq(shopOrderAdjustments.orderId, orderId),
          inArray(shopOrderAdjustments.kind, ["refund_full", "refund_partial"]),
        ),
      )
      .all();
    return rows[0]?.total ?? 0;
  }

  /** Net amount the customer has paid = order total − ledger refunds. */
  async paidTotalSatang(orderId: string): Promise<number> {
    const order = await this.db
      .select({ totalSatang: shopOrders.totalSatang })
      .from(shopOrders)
      .where(eq(shopOrders.id, orderId))
      .limit(1)
      .get();
    if (!order) throw new ShopValidationError("Order not found", "orderId");
    return order.totalSatang - (await this.refundedTotalSatang(orderId));
  }

  /**
   * Remaining refundable balance (#110) — the guard the admin route
   * used to compute inline now lives in the domain, so every caller
   * (admin action, webhook echo, future API) inherits it.
   */
  async refundableSatang(orderId: string): Promise<number> {
    return this.paidTotalSatang(orderId);
  }

  /**
   * Record a refund (partial or full) — appends an order_adjustments
   * ledger row, then derives the financial axis from the LEDGER SUM
   * vs the order total (partially_refunded below, refunded at/above).
   * Does NOT call the provider — the caller does that (so refund
   * attempts can fail cleanly without a stale DB row).
   *
   * Idempotency (#110): when `idempotencyKey` is supplied (admin UI
   * nonce, webhook-derived key) a replay with the SAME key and SAME
   * orderId+amount is a no-op returning the original row. The same
   * key with a DIFFERENT amount/order errors — a reused key must
   * never confirm a different refund. Enforced both by pre-check and
   * by the UNIQUE partial index (concurrent duplicate resolves via
   * re-read after the constraint fires).
   */
  async recordRefund(input: {
    orderId: string;
    amountSatang: number;
    reason?: string;
    createdBy?: string;
    kind: "refund_full" | "refund_partial";
    idempotencyKey?: string;
    providerRefundId?: string;
  }): Promise<{
    adjustmentId: string;
    replayed: boolean;
    refundedTotalSatang: number;
    financialStatus: OrderFinancialStatus;
  }> {
    const amount = Math.abs(input.amountSatang);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ShopValidationError(
        "Refund amount must be a positive integer satang value",
        "amountSatang",
      );
    }

    const order = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, input.orderId))
      .limit(1)
      .get();
    if (!order) throw new ShopValidationError("Order not found", "orderId");

    const findByKey = async () =>
      input.idempotencyKey
        ? await this.db
            .select()
            .from(shopOrderAdjustments)
            .where(
              eq(shopOrderAdjustments.idempotencyKey, input.idempotencyKey),
            )
            .limit(1)
            .get()
        : undefined;

    const asReplay = async (existing: {
      id: string;
      orderId: string;
      amountSatang: number;
    }) => {
      // Body-fingerprint check: same key, different request → error,
      // never a silent confirmation of the wrong refund.
      if (
        existing.orderId !== input.orderId ||
        Math.abs(existing.amountSatang) !== amount
      ) {
        throw new ShopValidationError(
          `Idempotency key '${input.idempotencyKey}' was already used for a different refund`,
          "idempotencyKey",
        );
      }
      const refundedTotal = await this.refundedTotalSatang(input.orderId);
      const fresh = await this.db
        .select({ financialStatus: shopOrders.financialStatus })
        .from(shopOrders)
        .where(eq(shopOrders.id, input.orderId))
        .limit(1)
        .get();
      return {
        adjustmentId: existing.id,
        replayed: true,
        refundedTotalSatang: refundedTotal,
        financialStatus: (fresh?.financialStatus ??
          order.financialStatus) as OrderFinancialStatus,
      };
    };

    const priorRow = await findByKey();
    if (priorRow) return asReplay(priorRow);

    // Refundable-balance guard, in the domain (#110): the ledger sum
    // caps every caller, not just the admin route.
    const priorRefunded = await this.refundedTotalSatang(input.orderId);
    const refundable = order.totalSatang - priorRefunded;
    if (amount > refundable) {
      throw new ShopValidationError(
        `Refund of ${amount} satang exceeds remaining refundable balance (${refundable} of ${order.totalSatang} total; ${priorRefunded} already refunded)`,
        "amountSatang",
      );
    }

    const nowIso = this.nowIso();
    const adjustmentId = nanoid();
    try {
      await this.db.insert(shopOrderAdjustments).values({
        id: adjustmentId,
        orderId: input.orderId,
        kind: input.kind,
        amountSatang: -amount, // refunds are negative in the ledger
        reason: input.reason ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: nowIso,
        providerRefundId: input.providerRefundId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      });
    } catch (err) {
      // Concurrent duplicate hit the UNIQUE partial index — resolve as
      // a replay of whichever writer won.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") && msg.includes("idempotency_key")) {
        const winner = await findByKey();
        if (winner) return asReplay(winner);
      }
      throw err;
    }

    // Derive the financial axis from the ledger (#110), and the legacy
    // status from the axes (#109).
    const refundedTotal = await this.refundedTotalSatang(input.orderId);
    const financialStatus: OrderFinancialStatus =
      refundedTotal >= order.totalSatang ? "refunded" : "partially_refunded";
    await this.db
      .update(shopOrders)
      .set({
        financialStatus,
        status: deriveLegacyStatus(financialStatus, order.fulfillmentStatus),
        refundedAt: financialStatus === "refunded" ? nowIso : order.refundedAt,
        updatedAt: nowIso,
      })
      .where(eq(shopOrders.id, input.orderId));

    this.emit("order.refunded", {
      ...this.eventPayload({
        ...order,
        financialStatus,
        status: deriveLegacyStatus(financialStatus, order.fulfillmentStatus),
      }),
      refundAmountSatang: amount,
      refundedTotalSatang: refundedTotal,
      refundKind: input.kind,
      providerRefundId: input.providerRefundId ?? null,
    });

    return {
      adjustmentId,
      replayed: false,
      refundedTotalSatang: refundedTotal,
      financialStatus,
    };
  }

  /**
   * Flip a paid order to fulfilled. Called from the admin dashboard.
   * #109: CAS on the fulfillment axis; a partially refunded order can
   * still ship its remaining items.
   */
  async markFulfilled(orderId: string): Promise<void> {
    const nowIso = this.nowIso();
    const result = await this.d1
      .prepare(
        `UPDATE shop_orders
         SET fulfillment_status = 'fulfilled',
             status = CASE financial_status
               WHEN 'paid' THEN 'fulfilled'
               WHEN 'partially_refunded' THEN 'fulfilled'
               ELSE status END,
             fulfilled_at = ?1,
             updated_at = ?1
         WHERE id = ?2
           AND fulfillment_status = 'unfulfilled'
           AND financial_status IN ('paid', 'partially_refunded')`,
      )
      .bind(nowIso, orderId)
      .run();
    const changed = (result.meta as { changes?: number })?.changes ?? 0;
    if (changed > 0) await this.emitForOrder("order.fulfilled", orderId);
  }

  async markDelivered(orderId: string): Promise<void> {
    const nowIso = this.nowIso();
    const result = await this.d1
      .prepare(
        `UPDATE shop_orders
         SET fulfillment_status = 'delivered',
             status = CASE financial_status
               WHEN 'paid' THEN 'delivered'
               WHEN 'partially_refunded' THEN 'delivered'
               ELSE status END,
             delivered_at = ?1,
             updated_at = ?1
         WHERE id = ?2
           AND fulfillment_status = 'fulfilled'
           AND financial_status IN ('paid', 'partially_refunded')`,
      )
      .bind(nowIso, orderId)
      .run();
    const changed = (result.meta as { changes?: number })?.changes ?? 0;
    if (changed > 0) await this.emitForOrder("order.delivered", orderId);
  }

  /** Re-read an order and emit an event with its current state. */
  private async emitForOrder(event: string, orderId: string): Promise<void> {
    if (!this.emitEvent) return;
    const row = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, orderId))
      .limit(1)
      .get();
    if (row) this.emit(event, this.eventPayload(row));
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
