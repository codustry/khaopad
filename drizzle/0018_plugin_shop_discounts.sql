-- @khaopad/plugin-shop v0.5.0 — discount codes.
-- Design in src/plugins/shop/schema-discount.ts.

CREATE TABLE `shop_discount_codes` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL,
  `kind` text NOT NULL,
  `value_satang` integer,
  `value_percent` real,
  `max_redemptions` integer,
  `max_per_customer` integer,
  `min_order_satang` integer,
  `starts_at` text,
  `ends_at` text,
  `active` integer DEFAULT true NOT NULL,
  `description` text,
  `created_by` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_discount_codes_code_unique` ON `shop_discount_codes` (`code`);
--> statement-breakpoint

CREATE TABLE `shop_discount_redemptions` (
  `discount_id` text NOT NULL,
  `order_id` text NOT NULL,
  `user_id` text,
  `user_email` text,
  `amount_satang` integer NOT NULL,
  `redeemed_at` text NOT NULL,
  PRIMARY KEY(`discount_id`, `order_id`),
  FOREIGN KEY (`discount_id`) REFERENCES `shop_discount_codes`(`id`) ON UPDATE no action ON DELETE cascade
);
