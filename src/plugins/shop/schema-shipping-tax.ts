/**
 * Shipping zones + rates + tax rates — v3.2 additions.
 *
 * Split from schema-cart.ts (short-lived cart state) because these
 * are long-lived configuration tables the admin edits rarely.
 *
 * Design decisions (from #57 issue spec):
 *
 * 1. **Manual first** — operator-configured zones + rates. No carrier
 *    integrations, no live rate lookup. The escape hatch is a per-
 *    order shipping-override on the admin order detail (v3.2 sub-PR
 *    3e already ships lifecycle transitions; the override field
 *    ships in a follow-up when we wire shipping into checkout).
 *
 * 2. **Zone priority** — orders resolve to the first zone (by
 *    ascending `priority`) whose `country_codes` JSON array contains
 *    the shipping address's ISO-3166 alpha-2 code. Duplicate country
 *    membership across zones is a config error; lowest priority wins.
 *
 * 3. **Rate types**: flat / weight_bracket / price_bracket / free_over.
 *    Weight brackets store `upper_bound_grams` per bracket + amount.
 *    Price brackets store `upper_bound_satang` + amount. NULL upper
 *    bound = "and above" (the last bracket).
 *
 * 4. **Tax model**: site setting (default rate + prices-include-tax
 *    boolean) + per-country override rows. Simpler than jurisdictions;
 *    matches Shopify's basic tier. Thailand's 7% VAT + optional 3%
 *    withholding on B2B invoices is documented for the v3.4 draft-
 *    order flow.
 *
 * 5. **All amounts in satang** — same convention as everywhere else
 *    in the shop plugin.
 */
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// ─── Shipping ───────────────────────────────────────────────

export const shopShippingZones = sqliteTable("shop_shipping_zones", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // "Thailand", "Southeast Asia", "Rest of world"
  priority: integer("priority").notNull().default(100),
  // JSON string array of ISO-3166 alpha-2 country codes ["TH","SG"].
  // Empty array is legal but the zone will never match — set it to
  // ["*"] to mean "all countries" and use priority for fallback.
  countryCodes: text("country_codes").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const shopShippingMethods = sqliteTable("shop_shipping_methods", {
  id: text("id").primaryKey(),
  zoneId: text("zone_id")
    .notNull()
    .references(() => shopShippingZones.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // "Standard (3-5 days)", "Express (next day)"
  rateType: text("rate_type", {
    enum: ["flat", "weight_bracket", "price_bracket", "free_over"],
  }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  position: integer("position").notNull().default(1),
  // Applicability filters. NULL means "no bound".
  minWeightGrams: integer("min_weight_grams"),
  maxWeightGrams: integer("max_weight_grams"),
  minSubtotalSatang: integer("min_subtotal_satang"),
  maxSubtotalSatang: integer("max_subtotal_satang"),
});

/**
 * Rate rows for a method. `flat` methods have one row with
 * amountSatang. `weight_bracket` methods have one row per bracket
 * ordered by `upperBoundGrams` asc — NULL upper bound = "and above".
 * `price_bracket` similar but keyed on subtotal. `free_over` methods
 * have one row with upperBoundSatang = threshold and amountSatang = 0.
 */
export const shopShippingRates = sqliteTable("shop_shipping_rates", {
  id: text("id").primaryKey(),
  methodId: text("method_id")
    .notNull()
    .references(() => shopShippingMethods.id, { onDelete: "cascade" }),
  upperBoundGrams: integer("upper_bound_grams"),
  upperBoundSatang: integer("upper_bound_satang"),
  amountSatang: integer("amount_satang").notNull(),
});

// ─── Tax ────────────────────────────────────────────────────

/**
 * Tax settings are stored in the existing `site_settings` KV table
 * under key `shop.tax`. This schema is only for per-country override
 * rows; the default rate + prices-inclusive toggle live in settings.
 *
 * Site setting shape (JSON string in site_settings.value):
 *   {
 *     enabled: boolean,
 *     defaultRatePct: number,          // e.g. 7 for Thailand's 7% VAT
 *     pricesIncludeTax: boolean,       // true for TH storefronts, false for US-style
 *     defaultTaxName: string           // "VAT" | "Sales Tax" | "GST"
 *   }
 */
export const shopTaxRates = sqliteTable(
  "shop_tax_rates",
  {
    // Composite PK on (country, region) so US-CA can override US.
    countryCode: text("country_code").notNull(),
    regionCode: text("region_code").notNull().default(""), // "" means country-wide
    name: text("name").notNull(), // "VAT", "GST", "Sales Tax"
    ratePct: real("rate_pct").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countryCode, t.regionCode] }),
  }),
);

// Snapshot: applied at checkout, frozen into the order for the
// receipt. Never re-derived from shopTaxRates (rate changes mid-flow
// would surprise the customer). Multiple rows per order line if a
// composite tax (e.g. VAT + city surcharge) applies.
export const shopOrderTaxLines = sqliteTable("shop_order_tax_lines", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  orderItemId: text("order_item_id"), // null for order-level lines (shipping tax)
  name: text("name").notNull(),
  ratePct: real("rate_pct").notNull(),
  amountSatang: integer("amount_satang").notNull(),
});

export type ShopShippingZone = typeof shopShippingZones.$inferSelect;
export type ShopShippingMethod = typeof shopShippingMethods.$inferSelect;
export type ShopShippingRate = typeof shopShippingRates.$inferSelect;
export type ShopTaxRate = typeof shopTaxRates.$inferSelect;
