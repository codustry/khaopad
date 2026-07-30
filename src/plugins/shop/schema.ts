/**
 * Schema for @khaopad/plugin-shop.
 *
 * 7 core catalog tables + 2 collection tables + 1 inventory reservation
 * ledger (deferred to v3.2 but the table lives here to keep migration
 * numbering simple). Table naming convention: all shop tables prefix
 * with `shop_` so `SELECT * FROM sqlite_master` stays legible and
 * cross-plugin collisions are impossible.
 *
 * Design decisions from the design-review pass (issue #56):
 *
 *   1. **SKU is UNIQUE** on shop_product_variants (nullable-unique —
 *      SQLite allows multiple NULLs; real values must be unique).
 *      Retrofitting SKU uniqueness after duplicates land is painful,
 *      so we lock it down at day one.
 *
 *   2. **Variant status enum** ('active' | 'archived'). Never hard-
 *      delete a variant — cart/order rows can still reference an
 *      archived variant. Archived variants stay hidden from admin
 *      lists + public storefronts but remain queryable for historical
 *      orders.
 *
 *   3. **Localizations in side table** (shop_product_localizations)
 *      mirrors the article/category/tag convention. Slug is shared
 *      across locales (Khao Pad convention). English localization is
 *      required for slug derivation — enforced in the createProduct()
 *      service layer, not the schema.
 *
 *   4. **Price and money in INTEGER satang** (100 satang = 1 baht).
 *      Never float. Every monetary column names its unit explicitly
 *      (priceSatang, compareAtSatang, costSatang, weightGrams). This
 *      applies to shipping and taxes in v3.2 too — no surprises.
 *
 *   5. **Inventory 3-state model**: onHand + reserved stored,
 *      available = onHand - reserved is COMPUTED (never stored).
 *      Concurrent-purchase safety via
 *        UPDATE ... SET reserved = reserved + qty WHERE (on_hand - reserved) >= qty
 *      + reject-not-retry on the losing side. Details in the ADR.
 *
 *   6. **Multi-warehouse-ready but single-location for v3.x**.
 *      shop_inventory_levels has (item_id, location_id) composite PK
 *      so v4 multi-warehouse ships without a rebuild — location_id
 *      is always 'default' for now.
 *
 *   7. **Cached variant title** ("Red / M") stored on the variant row.
 *      Recomputed and batched (single db.batch()) when an option value
 *      is edited. Storefront rendering doesn't pay for N joins.
 *
 *   8. **Order line-item snapshots** (title, sku, price at time of
 *      purchase) ship in v3.2's shop_order_items — this file plants
 *      the flag but the table is added in the v3.2 sub-PR to keep the
 *      2b diff manageable.
 *
 *   9. **Collections** are both manual (curated product list) and
 *      rules-based (query filter). shop_collection_products handles
 *      the manual case; the rules JSON on shop_collections handles
 *      smart collections. Deferring the rules-engine to a follow-up
 *      sub-PR — schema is here, code isn't yet.
 *
 *  10. **Media refs are bare text columns**, matching the core media
 *      pattern. No FK to `media.id` because R2 blobs can outlive
 *      product rows and vice versa; the media service handles orphan
 *      cleanup independently.
 */
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── Products ───────────────────────────────────────────────

export const shopProducts = sqliteTable(
  "shop_products",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    status: text("status", { enum: ["draft", "active", "archived"] })
      .notNull()
      .default("draft"),
    vendor: text("vendor"),
    productType: text("product_type"),
    tags: text("tags"), // JSON string array
    featuredMediaId: text("featured_media_id"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    publishedAt: text("published_at"),
  },
  (t) => ({
    statusIdx: uniqueIndex("shop_products_status_slug_idx").on(
      t.status,
      t.slug,
    ),
  }),
);

export const shopProductLocalizations = sqliteTable(
  "shop_product_localizations",
  {
    productId: text("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    descriptionMarkdown: text("description_markdown"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.productId, t.locale] }),
  }),
);

// ─── Product options + values ───────────────────────────────

export const shopProductOptions = sqliteTable("shop_product_options", {
  id: text("id").primaryKey(),
  productId: text("product_id")
    .notNull()
    .references(() => shopProducts.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // 'Size', 'Color'
  position: integer("position").notNull(), // 1..3 (Shopify convention: max 3 option axes)
});

export const shopProductOptionValues = sqliteTable(
  "shop_product_option_values",
  {
    id: text("id").primaryKey(),
    optionId: text("option_id")
      .notNull()
      .references(() => shopProductOptions.id, { onDelete: "cascade" }),
    value: text("value").notNull(), // 'M', 'Red'
    sortOrder: integer("sort_order").notNull().default(0),
    swatchHex: text("swatch_hex"), // optional color swatch (only meaningful for colour-ish options)
  },
);

// ─── Variants ───────────────────────────────────────────────

export const shopProductVariants = sqliteTable("shop_product_variants", {
  id: text("id").primaryKey(),
  productId: text("product_id")
    .notNull()
    .references(() => shopProducts.id, { onDelete: "cascade" }),
  // Must-fix: SKU is UNIQUE (nullable — SQLite allows multiple NULLs,
  // real values must be unique). Retrofitting uniqueness after
  // duplicates land is painful; lock it down day one.
  sku: text("sku").unique(),
  barcode: text("barcode"),
  // Must-fix: variant status — never hard-delete. Cart/order rows
  // can still reference an archived variant.
  status: text("status", { enum: ["active", "archived"] })
    .notNull()
    .default("active"),
  // Cached derived title ("Red / M"). Refreshed via db.batch() when
  // option values are edited; storefront rendering never pays for
  // the join across variant_options → option_values → options.
  titleCached: text("title_cached").notNull(),
  priceSatang: integer("price_satang").notNull(),
  compareAtSatang: integer("compare_at_satang"), // strike-through / MSRP
  weightGrams: integer("weight_grams"),
  requiresShipping: integer("requires_shipping", { mode: "boolean" })
    .notNull()
    .default(true),
  taxable: integer("taxable", { mode: "boolean" }).notNull().default(true),
  position: integer("position").notNull().default(1),
  mediaId: text("media_id"), // variant-specific media override
});

export const shopProductVariantOptions = sqliteTable(
  "shop_product_variant_options",
  {
    variantId: text("variant_id")
      .notNull()
      .references(() => shopProductVariants.id, { onDelete: "cascade" }),
    optionValueId: text("option_value_id")
      .notNull()
      .references(() => shopProductOptionValues.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.variantId, t.optionValueId] }),
  }),
);

// ─── Inventory ──────────────────────────────────────────────

export const shopInventoryItems = sqliteTable("shop_inventory_items", {
  id: text("id").primaryKey(),
  variantId: text("variant_id")
    .notNull()
    .unique()
    .references(() => shopProductVariants.id, { onDelete: "cascade" }),
  tracked: integer("tracked", { mode: "boolean" }).notNull().default(true),
  // costSatang is never shown to customers — for margin reporting only.
  costSatang: integer("cost_satang"),
  // Overselling policy — pre-orders + made-to-order need this to stay true.
  continueSellingWhenOutOfStock: integer("continue_selling_when_out_of_stock", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
});

export const shopInventoryLevels = sqliteTable(
  "shop_inventory_levels",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => shopInventoryItems.id, { onDelete: "cascade" }),
    // Single-location for v3.x. Column exists so v4 multi-warehouse
    // ships without a table rebuild — always 'default' for now.
    locationId: text("location_id").notNull().default("default"),
    onHand: integer("on_hand").notNull().default(0),
    // available = onHand - reserved is COMPUTED at query time.
    // Never stored — reserved is the mutable counter for pending carts.
    reserved: integer("reserved").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.itemId, t.locationId] }),
  }),
);

// ─── Collections ────────────────────────────────────────────

export const shopCollections = sqliteTable("shop_collections", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  status: text("status", { enum: ["draft", "active", "archived"] })
    .notNull()
    .default("draft"),
  kind: text("kind", { enum: ["manual", "smart"] })
    .notNull()
    .default("manual"),
  // Smart-collection rules: JSON blob evaluated by the query engine
  // when kind='smart'. Ignored when kind='manual'. Rules engine
  // itself ships in a follow-up sub-PR.
  rulesJson: text("rules_json"),
  featuredMediaId: text("featured_media_id"),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  publishedAt: text("published_at"),
});

export const shopCollectionLocalizations = sqliteTable(
  "shop_collection_localizations",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => shopCollections.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    descriptionMarkdown: text("description_markdown"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.collectionId, t.locale] }),
  }),
);

export const shopCollectionProducts = sqliteTable(
  "shop_collection_products",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => shopCollections.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.collectionId, t.productId] }),
  }),
);

// ─── Type exports ───────────────────────────────────────────

export type ShopProduct = typeof shopProducts.$inferSelect;
export type ShopProductLocalization =
  typeof shopProductLocalizations.$inferSelect;
export type ShopProductOption = typeof shopProductOptions.$inferSelect;
export type ShopProductOptionValue =
  typeof shopProductOptionValues.$inferSelect;
export type ShopProductVariant = typeof shopProductVariants.$inferSelect;
export type ShopInventoryItem = typeof shopInventoryItems.$inferSelect;
export type ShopInventoryLevel = typeof shopInventoryLevels.$inferSelect;
export type ShopCollection = typeof shopCollections.$inferSelect;

/**
 * Locale is free text (validated at write time against
 * SUPPORTED_LOCALES env var, matching the core convention). Not an
 * enum, so plugins that add locales don't need a schema change.
 */
export type ShopLocale = string;
