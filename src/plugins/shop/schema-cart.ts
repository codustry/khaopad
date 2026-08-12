/**
 * Cart + reservation ledger + orders — v3.2 additions to the shop
 * schema.
 *
 * Kept in a separate file from schema.ts (which is v3.1 catalog) so
 * the split is legible: catalog is a stable long-lived model, cart
 * data has a short TTL (30-day cart expiry, 15-min reservation TTL,
 * orders forever).
 *
 * Design decisions:
 *
 * 1. **Cart is session-cookie-scoped** — cartId lives in a signed
 *    HttpOnly cookie. Guest and logged-in checkout share the same
 *    cart table; the `userId` column is null for guests, set when
 *    the customer signs in mid-cart.
 *
 * 2. **Prices captured on cart_items at add-to-cart time** so a
 *    price change mid-session doesn't surprise the customer. The
 *    v3.2 checkout re-validates against current variant price and
 *    surfaces the delta if it moved.
 *
 * 3. **Reservation ledger** (shop_inventory_reservations) records
 *    every reservation with a 15-min TTL. Sweep cron (v3.2) walks
 *    expired rows and calls `releaseVariant()` from inventory.ts.
 *    Each ledger row references the cart_item so the sweep knows
 *    which reserved qty to release.
 *
 * 4. **Order line-item snapshot** — shop_order_items carries
 *    `titleSnapshot`, `skuSnapshot`, `priceSnapshotSatang`. Design-
 *    review must-fix: never lazy-join the variant row for historical
 *    receipts; the variant may be archived or the price changed.
 *
 * 5. **Order number is human-readable** — `KHP-YYYY-NNNNN` (Khao Pad
 *    year 5-digit sequence). Stored separately from `id` (nanoid).
 *    Customers reference the order number; the id is for internal use.
 *
 * 6. **Payment provider is opaque string** — `providerName` +
 *    `providerChargeId` on shop_orders. Beam ships in v3.2; Stripe +
 *    Omise ship in #61. Interface is the escape hatch.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { shopProductVariants } from "./schema";

// ─── Carts ──────────────────────────────────────────────────

export const shopCarts = sqliteTable(
  "shop_carts",
  {
    id: text("id").primaryKey(),
    // Set when the customer signs in mid-cart; null for guests.
    userId: text("user_id"),
    // Session cookie value that opened the cart. Rotated on sign-in
    // (session upgrade) — old value is preserved as `previousSessionId`
    // so a race between two tabs of the same guest doesn't lose items.
    sessionId: text("session_id").notNull(),
    previousSessionId: text("previous_session_id"),
    // Contact info collected during checkout. Nullable until customer
    // starts entering it (the initial add-to-cart is fully anonymous).
    email: text("email"),
    // 'open' | 'checkout_started' | 'ordered' | 'abandoned' | 'expired'
    // - open: normal browsing state
    // - checkout_started: inventory reservations have been placed
    //   (they hold for 15 minutes from this transition)
    // - ordered: payment succeeded, order row created
    // - abandoned: sweep detected no activity for 30 days
    // - expired: sweep detected checkout_started > 15 min without pay
    status: text("status", {
      enum: ["open", "checkout_started", "ordered", "abandoned", "expired"],
    })
      .notNull()
      .default("open"),
    // Set when status flips to checkout_started — used to compute
    // reservation expiry (checkoutStartedAt + 15 minutes).
    checkoutStartedAt: text("checkout_started_at"),
    // Multipurpose text column since v3.4:
    //   - `attribution:<articleId>` (v3.4 federation stash)
    //   - `<discountId>:<code>` (v3.5 discount, after checkout-start)
    //   - Plain code string (v3.5, right after POST /cart/discount but
    //     before checkout-start rewrites to the id:code form)
    // Real v3.5+ discount codes have their own tables — this column
    // now doubles as the cart's temporary bookkeeping slot.
    discountCode: text("discount_code"),
    // v3.5: set once the recovery email has been sent for this cart.
    // Prevents re-sending on every sweep tick. NULL = never sent.
    recoveryEmailSentAt: text("recovery_email_sent_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    sessionIdx: uniqueIndex("shop_carts_session_id_status_idx").on(
      t.sessionId,
      t.status,
    ),
  }),
);

export const shopCartItems = sqliteTable("shop_cart_items", {
  id: text("id").primaryKey(),
  cartId: text("cart_id")
    .notNull()
    .references(() => shopCarts.id, { onDelete: "cascade" }),
  variantId: text("variant_id")
    .notNull()
    .references(() => shopProductVariants.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  // Price snapshot at add-to-cart time. Never lazy-fetch — a price
  // change mid-session would silently rewrite the customer's cart.
  priceSatangAtAdd: integer("price_satang_at_add").notNull(),
  addedAt: text("added_at").notNull(),
});

// ─── Reservation ledger ─────────────────────────────────────

export const shopInventoryReservations = sqliteTable(
  "shop_inventory_reservations",
  {
    id: text("id").primaryKey(),
    // The cart_item this reservation is tied to. When the cart_item
    // is deleted, the reservation is also released (via app-code
    // callback into releaseVariant() — not FK cascade, because the
    // reservation ledger persists after the reservation is released
    // for audit purposes).
    cartItemId: text("cart_item_id").notNull(),
    variantId: text("variant_id").notNull(),
    quantity: integer("quantity").notNull(),
    // Set at reservation-create. `expiresAt = reservedAt + 15 min`.
    // Sweep cron walks WHERE released_at IS NULL AND expires_at < now.
    reservedAt: text("reserved_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    // Filled when the reservation is either committed to a sale
    // (payment success) or explicitly released (cart abandonment,
    // sweep). Null while active.
    releasedAt: text("released_at"),
    // 'committed' | 'released' | 'expired'
    releaseReason: text("release_reason", {
      enum: ["committed", "released", "expired"],
    }),
  },
);

// ─── Orders ─────────────────────────────────────────────────

export const shopOrders = sqliteTable(
  "shop_orders",
  {
    id: text("id").primaryKey(),
    // Human-readable — `KHP-YYYY-NNNNN`. Shown to customers, used in
    // support requests, printed on receipts.
    orderNumber: text("order_number").notNull().unique(),
    // Set when the customer was signed in at checkout; null for guests.
    userId: text("user_id"),
    // Always populated — collected during checkout.
    email: text("email").notNull(),
    // LEGACY single-axis status (#109). Kept for backward compat — every
    // existing read (funnel pages, admin lists, status endpoint) keeps
    // working. DERIVED on every write via deriveLegacyStatus() in
    // order-service.ts from the three axes below; never written directly
    // anywhere else. The UI migrates to the axes in Phase C.
    status: text("status", {
      enum: [
        "pending",
        "paid",
        "fulfilled",
        "delivered",
        "refunded",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),
    // ── Orthogonal status axes (#109) ──
    // Money state. `partially_refunded`/`refunded` are DERIVED from the
    // shop_order_adjustments ledger sum vs the order total (#110) — the
    // ledger is authoritative, this column is the indexed projection.
    financialStatus: text("financial_status", {
      enum: ["pending", "paid", "partially_refunded", "refunded", "cancelled"],
    })
      .notNull()
      .default("pending"),
    // Logistics state — deliberately coarse for now. `partially_fulfilled`
    // arrives when per-line fulfillment lands; don't over-model early.
    fulfillmentStatus: text("fulfillment_status", {
      enum: ["unfulfilled", "fulfilled", "delivered"],
    })
      .notNull()
      .default("unfulfilled"),
    // Return flow — null means "no return in progress" (the common case).
    returnStatus: text("return_status", {
      enum: ["requested", "approved", "received", "resolved"],
    }),
    // Sales channel — Phase E groundwork. 'tonbab_pos' and 'marketplace'
    // arrive later; adding the column now means one migration, not two.
    channel: text("channel").notNull().default("online_store"),
    // Payment provider that handled the charge. `beam` for v3.2;
    // `stripe` / `omise` land in #61.
    providerName: text("provider_name"),
    // Opaque charge id from the provider (Beam's chargeId, Stripe's
    // pi_..., etc.). Used to look up the charge for refunds.
    providerChargeId: text("provider_charge_id"),
    // Monetary totals, all in satang. Computed at checkout, frozen
    // into the order row — subsequent variant/price/tax changes do
    // not affect the historical order.
    subtotalSatang: integer("subtotal_satang").notNull(),
    shippingSatang: integer("shipping_satang").notNull().default(0),
    taxSatang: integer("tax_satang").notNull().default(0),
    // D5 (0028): VAT already contained in the total in prices-inclusive
    // mode (computeTotals' taxIncludedSatang — informational, NOT part
    // of the total formula). 0 in exclusive mode and for pre-0028 rows.
    taxIncludedSatang: integer("tax_included_satang").notNull().default(0),
    // D5 (0028): snapshot of the store's tax config at checkout time so
    // the finance report labels each order's VAT correctly even after a
    // config flip. 'exclusive' → VAT lives in tax_satang (added on top);
    // 'inclusive' → VAT lives in tax_included_satang (broken out).
    taxMode: text("tax_mode", { enum: ["exclusive", "inclusive"] })
      .notNull()
      .default("exclusive"),
    discountSatang: integer("discount_satang").notNull().default(0),
    totalSatang: integer("total_satang").notNull(),
    // Shipping address (JSON blob — the shipping-zone matcher parses
    // country_code; the rest is opaque to the shop plugin).
    shippingAddressJson: text("shipping_address_json"),
    // Billing address — often same as shipping. Nullable for digital-
    // only orders (variant.requiresShipping=false for all lines).
    billingAddressJson: text("billing_address_json"),
    // Applied at checkout — snapshot the discount code even though
    // shop_discount_codes table doesn't exist until v3.4. Text is
    // fine, we're just recording what was used.
    discountCodeSnapshot: text("discount_code_snapshot"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // Set when status flips to `paid` — the moment inventory was
    // committed and the customer got the receipt.
    paidAt: text("paid_at"),
    fulfilledAt: text("fulfilled_at"),
    deliveredAt: text("delivered_at"),
    refundedAt: text("refunded_at"),
    cancelledAt: text("cancelled_at"),
    // ── External identity (0030, #160 Phase E) ──
    // Set only on orders pushed in by an external system (Tonbab POS,
    // marketplaces). `externalSource` names the origin ('tonbab'),
    // `externalId` is that system's order id. Native orders leave both
    // NULL. The partial UNIQUE index below is what makes sync replays
    // idempotent at the DB layer.
    externalSource: text("external_source"),
    externalId: text("external_id"),
  },
  (t) => ({
    externalUq: uniqueIndex("shop_orders_external_source_id_uq")
      .on(t.externalSource, t.externalId)
      .where(sql`${t.externalSource} IS NOT NULL`),
  }),
);

// ─── Order line items ───────────────────────────────────────

export const shopOrderItems = sqliteTable(
  "shop_order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),
    // Variant FK is `RESTRICT` (not CASCADE) — historical orders must
    // always resolve back to a variant even if the product was later
    // deleted. Enforced by the variant status=archived flow (never
    // hard-delete a variant).
    variantId: text("variant_id")
      .notNull()
      .references(() => shopProductVariants.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    // Snapshot columns — design-review must-fix. Never lazy-join the
    // variant row for historical receipts.
    titleSnapshot: text("title_snapshot").notNull(),
    skuSnapshot: text("sku_snapshot"),
    priceSnapshotSatang: integer("price_snapshot_satang").notNull(),
    // Line total = priceSnapshotSatang * quantity, stored so the order
    // summary doesn't have to recompute on every read.
    lineSubtotalSatang: integer("line_subtotal_satang").notNull(),
    // Per-line tax (frozen at checkout).
    lineTaxSatang: integer("line_tax_satang").notNull().default(0),
    // Portion of the order-level discount allocated to this line (B1–B4
    // pure allocateDiscount()). Frozen at checkout like the other
    // snapshots; sums across lines to shop_orders.discount_satang.
    discountAllocatedSatang: integer("discount_allocated_satang")
      .notNull()
      .default(0),
  },
  (t) => ({
    // Covers the (order_id, id) lookup an external-order REPAIR does
    // (0031). External item ids are deterministic —
    // `ext:<orderId>:<lineIndex>` — so a replayed receipt collides on
    // the PRIMARY KEY rather than duplicating lines. A
    // UNIQUE(order_id, variant_id) is deliberately NOT used: a POS
    // receipt may carry the same SKU on two lines at different
    // counter prices.
    orderIdx: index("shop_order_items_order_id_idx").on(t.orderId, t.id),
  }),
);

// ─── Order adjustments ──────────────────────────────────────

/**
 * Miscellaneous adjustments that apply to the order — refunds (partial
 * or full), withholding tax lines, manual credits, etc. Sign convention:
 *   - Positive = adds to what customer paid (e.g. a manual surcharge)
 *   - Negative = reduces (refund, discount, withholding tax)
 *
 * Sums into the order's balance calculation; the running total is the
 * source of truth for "what does the customer owe" during a dispute.
 *
 * #110: this ledger is AUTHORITATIVE for refund totals. Refunds are
 * append-only INSERTs; `refundedTotalSatang()` in order-service.ts
 * derives by summing rows — never a mutated counter — and
 * `shop_orders.financial_status` flips to partially_refunded/refunded
 * from the ledger sum vs the order total. `idempotency_key` (UNIQUE
 * where present, partial index in 0025) makes a replayed refund a
 * no-op returning the original row; a reused key with a different
 * amount errors (body-fingerprint check in recordRefund).
 */
export const shopOrderAdjustments = sqliteTable("shop_order_adjustments", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => shopOrders.id, { onDelete: "cascade" }),
  kind: text("kind", {
    enum: [
      "refund_full",
      "refund_partial",
      "withholding_tax",
      "manual_credit",
      "manual_surcharge",
    ],
  }).notNull(),
  amountSatang: integer("amount_satang").notNull(),
  reason: text("reason"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
  // Gateway's refund transaction id (Beam refundId, Stripe re_...) —
  // the reconciliation join key. Null for non-refund adjustments and
  // pre-0025 rows.
  providerRefundId: text("provider_refund_id"),
  // Caller-supplied dedupe key (admin UI form nonce, webhook-derived
  // `beam:refund:<chargeId>`, ...). UNIQUE where non-null.
  idempotencyKey: text("idempotency_key"),
});

// ─── Type exports ───────────────────────────────────────────

export type ShopCart = typeof shopCarts.$inferSelect;
export type ShopCartItem = typeof shopCartItems.$inferSelect;
export type ShopInventoryReservation =
  typeof shopInventoryReservations.$inferSelect;
export type ShopOrder = typeof shopOrders.$inferSelect;
export type ShopOrderItem = typeof shopOrderItems.$inferSelect;
export type ShopOrderAdjustment = typeof shopOrderAdjustments.$inferSelect;

/** Cart items with variant + product context for rendering. */
export type ShopCartItemWithContext = ShopCartItem & {
  variantTitle: string;
  productSlug: string;
  productTitle: string;
  currentPriceSatang: number; // for price-change detection at checkout
  availableStock: number;
  mediaId: string | null;
};
