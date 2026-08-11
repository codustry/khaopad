/**
 * Schema for @khaopad/plugin-reviews.
 *
 * One table: `product_reviews`. The spec'd name is kept as-is (rather
 * than the soft `<slug>_*` prefix convention) because the table IS the
 * plugin's whole domain and the name reads better in JSON-LD tooling
 * and operator queries. Reviews reference shop products directly —
 * this plugin declares an explicit dependency on @khaopad/plugin-shop.
 *
 * Verified purchase: `verified` is set at submission time when the
 * (orderNumber, email) pair the reviewer supplied matches a PAID order
 * containing the reviewed product. Possession auth — same model as the
 * guest order lookup (/lookup) — no accounts dependency. `orderId` is
 * only stored when the match succeeded, so `verified=1 ⇒ orderId`.
 */
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { shopProducts } from "$plugins/shop/schema";
import { shopOrders } from "$plugins/shop/schema-cart";

export const productReviews = sqliteTable(
  "product_reviews",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => shopProducts.id, { onDelete: "cascade" }),
    // Set only when verified-purchase matching succeeded. SET NULL on
    // order deletion — the review outlives the order, but loses the
    // pointer (verified stays 1; it was true at submission time).
    orderId: text("order_id").references(() => shopOrders.id, {
      onDelete: "set null",
    }),
    email: text("email").notNull(),
    rating: integer("rating").notNull(), // 1..5, validated in service
    title: text("title").notNull(),
    body: text("body").notNull(),
    locale: text("locale").notNull().default("en"),
    status: text("status", {
      enum: ["pending", "approved", "rejected"],
    })
      .notNull()
      .default("pending"),
    verified: integer("verified").notNull().default(0),
    // SHA-256/16-hex of the submitter IP — same scheme as forms +
    // comments (never the raw IP). Drives the per-IP rate limit.
    ipHash: text("ip_hash"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    // The storefront's hot path: approved reviews for one product.
    productStatusIdx: index("product_reviews_product_status_idx").on(
      t.productId,
      t.status,
    ),
    // Rate-limit lookup: recent submissions by ip hash.
    ipCreatedIdx: index("product_reviews_ip_created_idx").on(
      t.ipHash,
      t.createdAt,
    ),
  }),
);

export type ProductReview = typeof productReviews.$inferSelect;
export type ReviewStatus = ProductReview["status"];
