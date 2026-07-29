-- @khaopad/plugin-shop v0.4.0 — article ↔ product federation.
-- One join table for the "Related products" / "Featured on articles"
-- relationships. Design in src/plugins/shop/schema-federation.ts.

CREATE TABLE `shop_article_product_refs` (
  `article_id` text NOT NULL,
  `product_id` text NOT NULL,
  `ref_kind` text DEFAULT 'mentioned' NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `created_by` text,
  PRIMARY KEY(`article_id`, `product_id`, `ref_kind`),
  FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Support "products for this article" AND "articles for this product"
-- lookup paths equally cheaply.
CREATE INDEX `shop_article_product_refs_article_idx` ON `shop_article_product_refs` (`article_id`);
--> statement-breakpoint
CREATE INDEX `shop_article_product_refs_product_idx` ON `shop_article_product_refs` (`product_id`);
