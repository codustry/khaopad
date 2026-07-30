/**
 * Discount codes — v3.5 addition to the shop plugin.
 *
 * Lifted from the BACtrack reference (codustry/bactrack-website) with
 * schema tightened for D1's constraints. Two tables:
 *   - shop_discount_codes: the code itself + its rules
 *   - shop_discount_redemptions: audit log of which order used which
 *     code, so per-customer limits are enforceable
 *
 * Design decisions (from #60 issue spec):
 *
 * 1. **Three kinds**: fixed_satang (flat off), percent (fraction off),
 *    free_shipping (zeroes the shipping line). Not a stacking model —
 *    one code per order, matches Shopify Basic. BOGO/tiered ships in
 *    a v3.6+ discount-engine plugin if demand shows up.
 *
 * 2. **Redemption caps**: `maxRedemptions` (global) + `maxPerCustomer`
 *    (guest = keyed by email, signed-in = keyed by user id). NULL
 *    on either means unlimited.
 *
 * 3. **Time window**: startsAt + endsAt, both ISO strings. NULL
 *    endsAt = never expires. Server-side validation only — client-side
 *    disabling of "apply" button is an escape hatch, not a security
 *    boundary.
 *
 * 4. **Repurposed cart.discountCode**: the existing `discountCode`
 *    column (from v3.4 attribution stash) now also stores real
 *    discount codes when they're applied. The write-guard from v3.4
 *    already handles the coexistence — `attribution:*` prefix vs
 *    plain code string. Webhook reads discountSnapshot from the
 *    order row (populated at checkout-start).
 *
 * 5. **discountSatang on order**: v3.2 already added the column;
 *    v3.5 now populates it via the discount-apply flow at checkout.
 */
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const shopDiscountCodes = sqliteTable(
  "shop_discount_codes",
  {
    id: text("id").primaryKey(),
    /** Case-insensitive lookup — canonicalized to UPPERCASE on write. */
    code: text("code").notNull(),
    kind: text("kind", {
      enum: ["fixed_satang", "percent", "free_shipping"],
    }).notNull(),
    /**
     * For `fixed_satang`: how much to subtract (in satang).
     * For `percent`: percentage as a decimal (10.5 = 10.5% off).
     * For `free_shipping`: ignored (write 0).
     */
    valueSatang: integer("value_satang"),
    valuePercent: real("value_percent"),
    /** NULL = unlimited global redemptions. */
    maxRedemptions: integer("max_redemptions"),
    /** NULL = unlimited per-customer. Guest keyed by email, user by id. */
    maxPerCustomer: integer("max_per_customer"),
    /**
     * Minimum order subtotal (satang) for the code to be applicable.
     * NULL = no minimum. Merchant-controlled soft floor.
     */
    minOrderSatang: integer("min_order_satang"),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    /** true = code accepts new redemptions. false = disabled. */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Human-readable description; shown in the admin only. */
    description: text("description"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    codeUnique: uniqueIndex("shop_discount_codes_code_unique").on(t.code),
  }),
);

export const shopDiscountRedemptions = sqliteTable(
  "shop_discount_redemptions",
  {
    // Composite PK on (discountId, orderId) — one redemption per code
    // per order. Prevents double-counting if the webhook fires twice.
    discountId: text("discount_id")
      .notNull()
      .references(() => shopDiscountCodes.id, { onDelete: "cascade" }),
    orderId: text("order_id").notNull(),
    /** Redeemer identity — user id if signed in, else the email used at checkout. */
    userId: text("user_id"),
    userEmail: text("user_email"),
    /** How much this code took off — snapshotted at redemption time. */
    amountSatang: integer("amount_satang").notNull(),
    redeemedAt: text("redeemed_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.discountId, t.orderId] }),
  }),
);

export type ShopDiscountCode = typeof shopDiscountCodes.$inferSelect;
export type ShopDiscountRedemption =
  typeof shopDiscountRedemptions.$inferSelect;
