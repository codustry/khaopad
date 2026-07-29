/**
 * Article ↔ product cross-references — v3.4's differentiator.
 *
 * Payload/Shopify Metaobjects call this "federation" — cross-content-
 * type references. Khao Pad's implementation is a plain join table
 * because articles and products live in the same D1: real FKs,
 * cascade deletes, no runtime resolution dance.
 *
 * Table lives in the shop plugin's schema-federation.ts because the
 * plugin owns the `shop_*` namespace + the migration numbering. Core
 * article code stays clean; it queries the join via a helper that
 * ships in the same plugin (getArticleProductRefs).
 *
 * Design decisions (from #59):
 *
 *   1. **refKind** = 'featured' | 'mentioned' | 'promoted' — lets an
 *      editor distinguish the article's headline product from a
 *      passing mention in the body. Storefront renders featured
 *      prominently, mentioned inline.
 *
 *   2. **position** for ordering — multiple refs per article are
 *      shown in the editor's chosen order.
 *
 *   3. **articleId is bare text** — no FK to core `articles` table
 *      because the plugin can't reach across plugin boundaries with
 *      FKs cleanly. Orphan cleanup runs at query time (ignore refs
 *      whose article id doesn't resolve). Small tradeoff for keeping
 *      the plugin decoupled from core.
 *
 *   4. **productId** IS an FK — same plugin owns both tables, so
 *      `onDelete: cascade` cleans up refs when a product is deleted.
 */
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { shopProducts } from "./schema";

export const shopArticleProductRefs = sqliteTable(
  "shop_article_product_refs",
  {
    articleId: text("article_id").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    refKind: text("ref_kind", {
      enum: ["featured", "mentioned", "promoted"],
    })
      .notNull()
      .default("mentioned"),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.articleId, t.productId, t.refKind] }),
  }),
);

export type ShopArticleProductRef = typeof shopArticleProductRefs.$inferSelect;
