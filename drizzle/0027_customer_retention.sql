-- v3.17 (#160 Phase D) — customer retention tables (D1, D4).
--
-- 1. customer_addresses — saved shipping addresses for passwordless
--    customer accounts (D1). Keyed to the Better Auth user id; shape
--    mirrors OrderAddress in order-service.ts so a saved row can be
--    posted to /api/shop/checkout/start verbatim. `is_default` drives
--    the checkout prefill (first default, else newest).
--
-- 2. back_in_stock_subscriptions — restock waitlist (D4). One row per
--    (variant, email); the UNIQUE index is the dedupe (INSERT OR
--    IGNORE). `notified_at` marks the notification as sent — rows are
--    notified at most once and stay as history rather than deleted, so
--    a re-subscribe after a notification is a fresh row (the old one
--    no longer blocks the UNIQUE because notified rows are purged on
--    re-subscribe by the module).

CREATE TABLE `customer_addresses` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `line1` text NOT NULL,
  `line2` text,
  `city` text NOT NULL,
  `region` text,
  `postal_code` text NOT NULL,
  `country_code` text NOT NULL,
  `phone` text,
  `is_default` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_addresses_user_id_idx` ON `customer_addresses` (`user_id`);
--> statement-breakpoint
CREATE TABLE `back_in_stock_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `variant_id` text NOT NULL,
  `email` text NOT NULL,
  `locale` text NOT NULL DEFAULT 'en',
  `created_at` text NOT NULL,
  `notified_at` text,
  FOREIGN KEY (`variant_id`) REFERENCES `shop_product_variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `back_in_stock_variant_email_idx` ON `back_in_stock_subscriptions` (`variant_id`, `email`);
--> statement-breakpoint
CREATE INDEX `back_in_stock_variant_pending_idx` ON `back_in_stock_subscriptions` (`variant_id`, `notified_at`);
