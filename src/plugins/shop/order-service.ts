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
 *
 * v3.16 (Phase C — C1/C2/C10):
 *   - Every transition also appends a shop_order_events timeline row
 *     (best-effort — a timeline write must never fail the order write).
 *     Admin free-text notes land in the same table (kind='note').
 *   - markFulfilled() records a shop_fulfillments row (carrier +
 *     tracking) and carries the tracking data in the order.fulfilled
 *     event payload.
 *   - Returns v1: shop_returns rows walk
 *     requested → approved → received → refunded (rejected from
 *     requested/approved) and drive the return_status axis (#109).
 *     The refund money itself still goes through recordRefund()'s
 *     ledger — the return state machine never touches satang.
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
import {
  shopFulfillments,
  shopOrderEvents,
  shopReturns,
  type OrderEventKind,
  type ReturnState,
  type ShopFulfillment,
  type ShopOrderEvent,
  type ShopReturn,
} from "./schema-operations";
import {
  commitVariantSale,
  releaseVariant,
  restoreVariantOnHand,
} from "./inventory";
import { ShopValidationError } from "./service";
import { allocateDiscount } from "./totals";
import { carrierLabel } from "./carriers";
import { formatSatang, type Satang } from "./money";

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
  /**
   * D5 (0028): VAT already contained in the total in prices-inclusive
   * mode (computeTotals.taxIncludedSatang) — informational, never part
   * of the total formula. Defaults to 0.
   */
  taxIncludedSatang?: number;
  /** D5 (0028): tax-config snapshot at checkout. Defaults 'exclusive'. */
  taxMode?: "exclusive" | "inclusive";
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

/**
 * #160 Phase E — an order pushed in by an external system (Tonbab POS).
 * Items are pre-resolved to variants by the sync layer (SKU matching
 * lives there); totals are taken AS SUPPLIED — the external system is
 * authoritative for its own sales and we never recompute them.
 */
export type CreateExternalOrderInput = {
  externalSource: string;
  externalId: string;
  email: string;
  channel: string;
  /** POS sales usually arrive already paid. */
  paid: boolean;
  /** When the sale happened at the origin; defaults to now. */
  placedAt?: string | null;
  items: Array<{
    variantId: string;
    quantity: number;
    titleSnapshot: string;
    skuSnapshot: string | null;
    priceSnapshotSatang: number;
  }>;
  subtotalSatang: number;
  shippingSatang?: number;
  taxSatang?: number;
  discountSatang?: number;
  totalSatang: number;
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
   * Append a timeline row (C2). Best-effort by design — the timeline
   * is an operational convenience, and a failed audit write must never
   * fail the money/lifecycle write that triggered it (same contract as
   * emit()).
   */
  private async logEvent(input: {
    orderId: string;
    kind: OrderEventKind;
    message?: string | null;
    actorEmail?: string | null;
    at?: string;
  }): Promise<void> {
    try {
      await this.db.insert(shopOrderEvents).values({
        id: nanoid(),
        orderId: input.orderId,
        kind: input.kind,
        message: input.message ?? null,
        actorEmail: input.actorEmail ?? null,
        createdAt: input.at ?? this.nowIso(),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[shop.order] timeline write failed for '${input.kind}' on ${input.orderId}:`,
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
          taxIncludedSatang: input.taxIncludedSatang ?? 0,
          taxMode: input.taxMode ?? "exclusive",
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
    await this.logEvent({
      orderId,
      kind: "created",
      message: `Order ${orderNumber} created (${formatSatang(totalSatang as Satang)})`,
      at: nowIso,
    });

    return { orderId, orderNumber };
  }

  /** Locate an order by its external identity (#160 Phase E). */
  async getOrderByExternal(
    source: string,
    externalId: string,
  ): Promise<ShopOrder | null> {
    const row = await this.db
      .select()
      .from(shopOrders)
      .where(
        and(
          eq(shopOrders.externalSource, source),
          eq(shopOrders.externalId, externalId),
        ),
      )
      .limit(1)
      .get();
    return row ?? null;
  }

  /**
   * Create an order pushed in by an external system (#160 Phase E —
   * Tonbab POS sync). Differences from createFromCart, all deliberate:
   *
   *   - **No cart, no reservations.** The sale already happened at the
   *     origin; there is nothing to reserve or commit. Inventory
   *     bookkeeping is the CALLER's job (deductVariantOnHand — on-hand
   *     only, since POS stock was never reserved).
   *   - **Totals as supplied.** The external system is authoritative
   *     for its own sales — we never recompute, re-tax or re-allocate
   *     its numbers. Per-line discount allocation is likewise not
   *     derived (discountAllocatedSatang = 0): refund math for POS
   *     orders belongs to the POS.
   *   - **NO order.created emission — echo-loop guard.** These orders
   *     originate FROM the external system; echoing order.created back
   *     out through the webhook dispatcher would make Tonbab re-import
   *     its own sale. Later lifecycle events (paid/fulfilled/...) DO
   *     emit, carrying `channel` in the payload so Tonbab self-filters.
   *   - **Idempotent on (externalSource, externalId).** A replay
   *     returns the existing order (`replayed: true`) instead of
   *     duplicating; the 0030 partial UNIQUE index backstops races.
   *     A replay against a HALF-created order (header row committed,
   *     items insert died — D1 has no cross-statement transaction
   *     here) repairs the missing item rows and reports
   *     `repaired: true` so the caller re-runs its inventory
   *     bookkeeping exactly once.
   */
  async createExternalOrder(input: CreateExternalOrderInput): Promise<{
    orderId: string;
    orderNumber: string;
    replayed: boolean;
    /** Replay found the order without items and re-inserted them. */
    repaired: boolean;
  }> {
    if (input.items.length === 0) {
      throw new ShopValidationError("External order has no items", "items");
    }

    const existing = await this.getOrderByExternal(
      input.externalSource,
      input.externalId,
    );
    if (existing) return this.replayExternalOrder(existing, input);

    const now = new Date();
    const nowIso = now.toISOString();
    const placedAt = input.placedAt ?? nowIso;
    const orderId = nanoid();
    const financialStatus: OrderFinancialStatus = input.paid
      ? "paid"
      : "pending";

    let orderNumber = await nextOrderNumber(this.d1, now);
    let attempts = 0;
    while (attempts < 5) {
      try {
        await this.db.insert(shopOrders).values({
          id: orderId,
          orderNumber,
          userId: null,
          email: input.email,
          status: deriveLegacyStatus(financialStatus, "unfulfilled"),
          financialStatus,
          fulfillmentStatus: "unfulfilled",
          returnStatus: null,
          channel: input.channel,
          providerName: null,
          providerChargeId: null,
          subtotalSatang: input.subtotalSatang,
          shippingSatang: input.shippingSatang ?? 0,
          taxSatang: input.taxSatang ?? 0,
          taxIncludedSatang: 0,
          taxMode: "exclusive",
          discountSatang: input.discountSatang ?? 0,
          totalSatang: input.totalSatang,
          shippingAddressJson: null,
          billingAddressJson: null,
          discountCodeSnapshot: null,
          createdAt: placedAt,
          updatedAt: nowIso,
          paidAt: input.paid ? placedAt : null,
          fulfilledAt: null,
          deliveredAt: null,
          refundedAt: null,
          cancelledAt: null,
          externalSource: input.externalSource,
          externalId: input.externalId,
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") && msg.includes("order_number")) {
          attempts++;
          orderNumber = await nextOrderNumber(this.d1, now);
          continue;
        }
        if (msg.includes("UNIQUE") && msg.includes("external")) {
          // Concurrent replay lost the race to the 0030 partial index —
          // resolve as a replay of whichever writer won.
          const winner = await this.getOrderByExternal(
            input.externalSource,
            input.externalId,
          );
          if (winner) return this.replayExternalOrder(winner, input);
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

    await this.insertExternalOrderItems(orderId, input.items);

    // Echo-loop guard: NO this.emit("order.created", ...) here — the
    // origin system already knows about its own order (see docblock).
    await this.logEvent({
      orderId,
      kind: "sync",
      message: `Imported from ${input.externalSource} (${input.externalId}, ${formatSatang(
        input.totalSatang as Satang,
      )}${input.paid ? ", paid" : ""})`,
      actorEmail: `${input.externalSource}-sync`,
      at: nowIso,
    });

    return { orderId, orderNumber, replayed: false, repaired: false };
  }

  /**
   * Insert external-order line items in chunks of ≤9 rows. Each row
   * binds 10 columns, so a single multi-row INSERT crosses D1's
   * 100-bind ceiling at 11+ items — a receipt-sized POS order. 9 rows
   * = 90 binds, matching the project's 90-headroom convention.
   */
  private async insertExternalOrderItems(
    orderId: string,
    items: CreateExternalOrderInput["items"],
  ): Promise<void> {
    const CHUNK = 9;
    for (let i = 0; i < items.length; i += CHUNK) {
      await this.db.insert(shopOrderItems).values(
        items.slice(i, i + CHUNK).map((item) => ({
          id: nanoid(),
          orderId,
          variantId: item.variantId,
          quantity: item.quantity,
          titleSnapshot: item.titleSnapshot,
          skuSnapshot: item.skuSnapshot,
          priceSnapshotSatang: item.priceSnapshotSatang,
          lineSubtotalSatang: item.priceSnapshotSatang * item.quantity,
          lineTaxSatang: 0,
          // Deliberately 0 — see createExternalOrder docblock
          // (external totals are opaque).
          discountAllocatedSatang: 0,
        })),
      );
    }
  }

  /**
   * Resolve a replayed external push against an existing order.
   *
   * The header insert and the items insert are separate D1 statements
   * (no transaction), so a crash between them leaves a permanent
   * order row with ZERO items — and a naive replay answer would then
   * acknowledge that husk forever: totals but no lines, and no
   * inventory ever deducted. Detect the husk and REPAIR it by
   * inserting the items now; `repaired: true` tells the caller to run
   * its inventory bookkeeping (which only ever ran after a fully
   * successful create).
   */
  private async replayExternalOrder(
    existing: ShopOrder,
    input: CreateExternalOrderInput,
  ): Promise<{
    orderId: string;
    orderNumber: string;
    replayed: boolean;
    repaired: boolean;
  }> {
    const itemCount = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(shopOrderItems)
      .where(eq(shopOrderItems.orderId, existing.id))
      .get();
    if ((itemCount?.n ?? 0) > 0) {
      // Fully-created order — plain idempotent replay, nothing changes.
      return {
        orderId: existing.id,
        orderNumber: existing.orderNumber,
        replayed: true,
        repaired: false,
      };
    }

    await this.insertExternalOrderItems(existing.id, input.items);
    await this.logEvent({
      orderId: existing.id,
      kind: "sync",
      message: `Repaired half-imported ${input.externalSource} order (${input.externalId}): item rows restored on replay`,
      actorEmail: `${input.externalSource}-sync`,
      at: this.nowIso(),
    });
    return {
      orderId: existing.id,
      orderNumber: existing.orderNumber,
      replayed: true,
      repaired: true,
    };
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
  }): Promise<OrderWithItems & { justPaid: boolean }> {
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
      // C4: `justPaid: false` tells the caller this was a retry/echo —
      // operator notifications and other winner-only side effects skip.
      return { ...(await this.hydrate(order)), justPaid: false };
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
    await this.logEvent({
      orderId: order.id,
      kind: "paid",
      message: `Payment confirmed (${formatSatang(order.totalSatang as Satang)} via ${order.providerName ?? "provider"})`,
      at: nowIso,
    });

    return { ...(await this.hydrate(paidOrder)), justPaid: true };
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

    // Inventory unwind depends on how the stock was taken (#160 Phase
    // E). Keyed on the ORDER here — not the calling path — so an
    // admin-UI cancel of a POS order behaves exactly like a sync-path
    // cancel.
    //
    //  - Native (web) orders reserved stock at checkout-start:
    //    releaseVariant() gives the reservation back.
    //  - External (POS) orders NEVER reserved: releaseVariant() would
    //    decrement `reserved` that belongs to live web customers'
    //    carts — silently stealing their holds. Instead, if the import
    //    deducted on-hand (order arrived paid), put those units back.
    //    An unpaid external order deducted nothing → nothing to unwind.
    const isExternal =
      Boolean(order.externalSource) || order.channel === "tonbab_pos";
    for (const item of items) {
      try {
        if (isExternal) {
          if (
            order.financialStatus === "paid" ||
            order.financialStatus === "partially_refunded"
          ) {
            await restoreVariantOnHand(this.d1, item.variantId, item.quantity);
          }
        } else {
          await releaseVariant(this.d1, item.variantId, item.quantity);
        }
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
    await this.logEvent({
      orderId: order.id,
      kind: "cancelled",
      message: "Order cancelled (payment failed or abandoned)",
      at: nowIso,
    });
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
    /** Acting admin's email for the timeline (C2); null = system. */
    actorEmail?: string;
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

    // C2: the write-only refund `reason` (B6) finally becomes readable —
    // amount + reason land on the timeline. Winner-only: idempotent
    // replays return above and never duplicate the event.
    await this.logEvent({
      orderId: input.orderId,
      kind: "refund",
      message: `Refunded ${formatSatang(amount as Satang)}${
        input.kind === "refund_full" ? " (full)" : ""
      }${input.reason ? ` — ${input.reason}` : ""}`,
      actorEmail: input.actorEmail ?? null,
      at: nowIso,
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
   *
   * C1: the winner also records a shop_fulfillments row (carrier +
   * tracking number), appends the timeline event, and carries the
   * tracking data in the order.fulfilled payload so webhook consumers
   * (LINE bots, Shippop bridges) see it without a second query.
   * Returns the fulfillment row when the transition happened, null on
   * the idempotent no-op path (already fulfilled / not payable).
   */
  async markFulfilled(
    orderId: string,
    opts: {
      carrier?: string | null;
      trackingNumber?: string | null;
      actorEmail?: string | null;
    } = {},
  ): Promise<ShopFulfillment | null> {
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
    if (changed === 0) return null;

    const fulfillment: ShopFulfillment = {
      id: nanoid(),
      orderId,
      carrier: opts.carrier ?? null,
      trackingNumber: opts.trackingNumber ?? null,
      fulfilledAt: nowIso,
      notifiedAt: null,
    };
    await this.db.insert(shopFulfillments).values(fulfillment);

    const trackingBits = [
      opts.carrier ? carrierLabel(opts.carrier) : null,
      opts.trackingNumber ?? null,
    ].filter(Boolean);
    await this.logEvent({
      orderId,
      kind: "fulfilled",
      message:
        trackingBits.length > 0
          ? `Shipped via ${trackingBits.join(" — ")}`
          : "Marked fulfilled",
      actorEmail: opts.actorEmail ?? null,
      at: nowIso,
    });

    // Existing order.fulfilled event, now with tracking in the payload.
    if (this.emitEvent) {
      const row = await this.db
        .select()
        .from(shopOrders)
        .where(eq(shopOrders.id, orderId))
        .limit(1)
        .get();
      if (row) {
        this.emit("order.fulfilled", {
          ...this.eventPayload(row),
          carrier: fulfillment.carrier,
          trackingNumber: fulfillment.trackingNumber,
        });
      }
    }
    return fulfillment;
  }

  /**
   * Latest fulfillment row for an order (C1). Order-level today; the
   * newest row is the one shown to customers and emailed.
   */
  async latestFulfillment(orderId: string): Promise<ShopFulfillment | null> {
    const row = await this.db
      .select()
      .from(shopFulfillments)
      .where(eq(shopFulfillments.orderId, orderId))
      .orderBy(sql`${shopFulfillments.fulfilledAt} DESC`)
      .limit(1)
      .get();
    return row ?? null;
  }

  /** Stamp the shipped-email send time on a fulfillment (C1). */
  async markFulfillmentNotified(fulfillmentId: string): Promise<void> {
    await this.db
      .update(shopFulfillments)
      .set({ notifiedAt: this.nowIso() })
      .where(eq(shopFulfillments.id, fulfillmentId));
  }

  async markDelivered(
    orderId: string,
    opts: { actorEmail?: string | null } = {},
  ): Promise<void> {
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
    if (changed > 0) {
      await this.emitForOrder("order.delivered", orderId);
      await this.logEvent({
        orderId,
        kind: "delivered",
        message: "Marked delivered",
        actorEmail: opts.actorEmail ?? null,
        at: nowIso,
      });
    }
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

  // ── Timeline + notes (C2) ───────────────────────────────

  /**
   * Admin free-text note on the order timeline. Unlike transition
   * events this is NOT best-effort — the note is the whole write, so
   * a failure must surface to the form.
   */
  async addOrderNote(input: {
    orderId: string;
    message: string;
    actorEmail?: string | null;
  }): Promise<ShopOrderEvent> {
    const message = input.message.trim();
    if (!message) {
      throw new ShopValidationError("Note cannot be empty", "message");
    }
    const order = await this.db
      .select({ id: shopOrders.id })
      .from(shopOrders)
      .where(eq(shopOrders.id, input.orderId))
      .limit(1)
      .get();
    if (!order) throw new ShopValidationError("Order not found", "orderId");
    const row: ShopOrderEvent = {
      id: nanoid(),
      orderId: input.orderId,
      kind: "note",
      message,
      actorEmail: input.actorEmail ?? null,
      createdAt: this.nowIso(),
    };
    await this.db.insert(shopOrderEvents).values(row);
    return row;
  }

  /** Timeline for an order, newest first (C2). */
  async listOrderEvents(orderId: string): Promise<ShopOrderEvent[]> {
    return this.db
      .select()
      .from(shopOrderEvents)
      .where(eq(shopOrderEvents.orderId, orderId))
      .orderBy(
        sql`${shopOrderEvents.createdAt} DESC, ${shopOrderEvents.id} DESC`,
      )
      .all();
  }

  // ── Returns v1 (C10) ────────────────────────────────────

  /**
   * Which return-machine states an order's `return_status` axis shows.
   * requested/approved/received map 1:1; both terminals collapse to
   * 'resolved' (#109's enum has one terminal on purpose — "was it
   * refunded or rejected" is the RETURN row's business, the axis only
   * says "no return in flight").
   */
  private static RETURN_AXIS: Record<ReturnState, OrderReturnStatus> = {
    requested: "requested",
    approved: "approved",
    received: "received",
    refunded: "resolved",
    rejected: "resolved",
  };

  /** Legal transitions of the returns state machine (C10). */
  private static RETURN_TRANSITIONS: Record<ReturnState, ReturnState[]> = {
    requested: ["approved", "rejected"],
    approved: ["received", "rejected"],
    received: ["refunded"],
    refunded: [],
    rejected: [],
  };

  /**
   * Customer-initiated return request. Guards:
   *   - financial axis must be paid | partially_refunded (nothing to
   *     return before payment; fully refunded orders are done),
   *   - fulfillment axis must be fulfilled | delivered (you cannot
   *     return what never shipped),
   *   - no other return may be in flight (requested/approved/received).
   * Auth (possession of order-number + email) is the ROUTE's job —
   * same model as /lookup.
   */
  async requestReturn(input: {
    orderId: string;
    reasonText?: string | null;
    items?: Array<{ orderItemId: string; quantity: number }> | null;
  }): Promise<ShopReturn> {
    const order = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, input.orderId))
      .limit(1)
      .get();
    if (!order) throw new ShopValidationError("Order not found", "orderId");
    if (
      order.financialStatus !== "paid" &&
      order.financialStatus !== "partially_refunded"
    ) {
      throw new ShopValidationError(
        `Order is not returnable (financial status: ${order.financialStatus})`,
        "financialStatus",
      );
    }
    if (
      order.fulfillmentStatus !== "fulfilled" &&
      order.fulfillmentStatus !== "delivered"
    ) {
      throw new ShopValidationError(
        `Order has not shipped yet (fulfillment status: ${order.fulfillmentStatus})`,
        "fulfillmentStatus",
      );
    }
    const open = (await this.listReturns(input.orderId)).find(
      (r) =>
        r.state === "requested" ||
        r.state === "approved" ||
        r.state === "received",
    );
    if (open) {
      throw new ShopValidationError(
        `A return is already in progress (${open.state})`,
        "returnStatus",
      );
    }

    const nowIso = this.nowIso();
    const row: ShopReturn = {
      id: nanoid(),
      orderId: input.orderId,
      state: "requested",
      reasonText: input.reasonText?.trim() || null,
      itemsJson:
        input.items && input.items.length > 0
          ? JSON.stringify(input.items)
          : null,
      createdAt: nowIso,
      resolvedAt: null,
    };
    await this.db.insert(shopReturns).values(row);
    await this.syncReturnAxis(order, "requested", nowIso);
    await this.logEvent({
      orderId: input.orderId,
      kind: "return_requested",
      message: `Customer requested a return${row.reasonText ? ` — ${row.reasonText}` : ""}`,
      at: nowIso,
    });
    return row;
  }

  /**
   * Admin-side return transition (C10). Validates against
   * RETURN_TRANSITIONS; the refund MONEY for received → refunded goes
   * through the existing recordRefund() ledger path first (the admin
   * route wires the two together) — this method only moves state.
   */
  async transitionReturn(input: {
    returnId: string;
    to: ReturnState;
    actorEmail?: string | null;
  }): Promise<ShopReturn> {
    const ret = await this.db
      .select()
      .from(shopReturns)
      .where(eq(shopReturns.id, input.returnId))
      .limit(1)
      .get();
    if (!ret) throw new ShopValidationError("Return not found", "returnId");
    const legal = OrderService.RETURN_TRANSITIONS[ret.state as ReturnState];
    if (!legal?.includes(input.to)) {
      throw new ShopValidationError(
        `Illegal return transition ${ret.state} → ${input.to}`,
        "state",
      );
    }
    const order = await this.db
      .select()
      .from(shopOrders)
      .where(eq(shopOrders.id, ret.orderId))
      .limit(1)
      .get();
    if (!order) throw new ShopValidationError("Order not found", "orderId");

    const nowIso = this.nowIso();
    const terminal = input.to === "refunded" || input.to === "rejected";
    await this.db
      .update(shopReturns)
      .set({
        state: input.to,
        resolvedAt: terminal ? nowIso : null,
      })
      .where(eq(shopReturns.id, ret.id));
    await this.syncReturnAxis(order, input.to, nowIso);

    const eventKind: OrderEventKind = (
      {
        approved: "return_approved",
        received: "return_received",
        refunded: "return_refunded",
        rejected: "return_rejected",
      } as Record<string, OrderEventKind>
    )[input.to];
    const messages: Record<string, string> = {
      approved: "Return approved",
      received: "Return received",
      refunded: "Return refunded",
      rejected: "Return rejected",
    };
    await this.logEvent({
      orderId: ret.orderId,
      kind: eventKind,
      message: messages[input.to],
      actorEmail: input.actorEmail ?? null,
      at: nowIso,
    });
    return { ...ret, state: input.to, resolvedAt: terminal ? nowIso : null };
  }

  /** Returns for an order, newest first (C10). */
  async listReturns(orderId: string): Promise<ShopReturn[]> {
    return this.db
      .select()
      .from(shopReturns)
      .where(eq(shopReturns.orderId, orderId))
      .orderBy(sql`${shopReturns.createdAt} DESC, ${shopReturns.id} DESC`)
      .all();
  }

  /** Project a return state onto the order's return_status axis (#109). */
  private async syncReturnAxis(
    order: ShopOrder,
    state: ReturnState,
    nowIso: string,
  ): Promise<void> {
    await this.db
      .update(shopOrders)
      .set({
        returnStatus: OrderService.RETURN_AXIS[state],
        updatedAt: nowIso,
      })
      .where(eq(shopOrders.id, order.id));
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
