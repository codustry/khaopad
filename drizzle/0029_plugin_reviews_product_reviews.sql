-- @khaopad/plugin-reviews v0.1.0 (#160 Phase D, D2)
-- Product reviews with moderation + verified-purchase flag.
-- Naming convention for plugin migrations: <NNNN>_plugin_<slug>_<desc>.sql
-- (see drizzle/0012_plugin_hello_pings.sql and docs/plugin-authoring.md).

CREATE TABLE `product_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `order_id` text,
  `email` text NOT NULL,
  `rating` integer NOT NULL CHECK (`rating` BETWEEN 1 AND 5),
  `title` text NOT NULL,
  `body` text NOT NULL,
  `locale` text DEFAULT 'en' NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `verified` integer DEFAULT 0 NOT NULL,
  `ip_hash` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `product_reviews_product_status_idx` ON `product_reviews` (`product_id`,`status`);
--> statement-breakpoint
CREATE INDEX `product_reviews_ip_created_idx` ON `product_reviews` (`ip_hash`,`created_at`);
