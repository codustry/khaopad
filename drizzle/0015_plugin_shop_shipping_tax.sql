-- @khaopad/plugin-shop v0.3.0 — shipping zones + rates + tax rates
-- Design in src/plugins/shop/schema-shipping-tax.ts.

CREATE TABLE `shop_shipping_zones` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `priority` integer DEFAULT 100 NOT NULL,
  `country_codes` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint

CREATE TABLE `shop_shipping_methods` (
  `id` text PRIMARY KEY NOT NULL,
  `zone_id` text NOT NULL,
  `name` text NOT NULL,
  `rate_type` text NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `position` integer DEFAULT 1 NOT NULL,
  `min_weight_grams` integer,
  `max_weight_grams` integer,
  `min_subtotal_satang` integer,
  `max_subtotal_satang` integer,
  FOREIGN KEY (`zone_id`) REFERENCES `shop_shipping_zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_shipping_rates` (
  `id` text PRIMARY KEY NOT NULL,
  `method_id` text NOT NULL,
  `upper_bound_grams` integer,
  `upper_bound_satang` integer,
  `amount_satang` integer NOT NULL,
  FOREIGN KEY (`method_id`) REFERENCES `shop_shipping_methods`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_tax_rates` (
  `country_code` text NOT NULL,
  `region_code` text DEFAULT '' NOT NULL,
  `name` text NOT NULL,
  `rate_pct` real NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  PRIMARY KEY(`country_code`, `region_code`)
);
--> statement-breakpoint

CREATE TABLE `shop_order_tax_lines` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `order_item_id` text,
  `name` text NOT NULL,
  `rate_pct` real NOT NULL,
  `amount_satang` integer NOT NULL
);
