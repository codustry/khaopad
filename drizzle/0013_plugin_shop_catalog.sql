-- @khaopad/plugin-shop v0.1.0 — catalog tables
-- Creates the 7 core catalog tables + 3 collection tables + 2 inventory
-- tables that back the v3.1 shop plugin. See src/plugins/shop/schema.ts
-- for design rationale (SKU UNIQUE, variant status enum, inventory
-- 3-state model, single-location v3.x, multi-warehouse-ready).
--
-- Naming: all shop tables prefix `shop_` so cross-plugin collisions
-- are impossible and sqlite_master stays legible.

CREATE TABLE `shop_products` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `vendor` text,
  `product_type` text,
  `tags` text,
  `featured_media_id` text,
  `seo_title` text,
  `seo_description` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_products_slug_unique` ON `shop_products` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_products_status_slug_idx` ON `shop_products` (`status`, `slug`);
--> statement-breakpoint

CREATE TABLE `shop_product_localizations` (
  `product_id` text NOT NULL,
  `locale` text NOT NULL,
  `title` text NOT NULL,
  `description_markdown` text,
  PRIMARY KEY(`product_id`, `locale`),
  FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_product_options` (
  `id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `name` text NOT NULL,
  `position` integer NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_product_option_values` (
  `id` text PRIMARY KEY NOT NULL,
  `option_id` text NOT NULL,
  `value` text NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `swatch_hex` text,
  FOREIGN KEY (`option_id`) REFERENCES `shop_product_options`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_product_variants` (
  `id` text PRIMARY KEY NOT NULL,
  `product_id` text NOT NULL,
  `sku` text,
  `barcode` text,
  `status` text DEFAULT 'active' NOT NULL,
  `title_cached` text NOT NULL,
  `price_satang` integer NOT NULL,
  `compare_at_satang` integer,
  `weight_grams` integer,
  `requires_shipping` integer DEFAULT true NOT NULL,
  `taxable` integer DEFAULT true NOT NULL,
  `position` integer DEFAULT 1 NOT NULL,
  `media_id` text,
  FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- SKU is UNIQUE (nullable-unique in SQLite: multiple NULLs allowed,
-- real values must be unique). Design-review must-fix.
CREATE UNIQUE INDEX `shop_product_variants_sku_unique` ON `shop_product_variants` (`sku`);
--> statement-breakpoint

CREATE TABLE `shop_product_variant_options` (
  `variant_id` text NOT NULL,
  `option_value_id` text NOT NULL,
  PRIMARY KEY(`variant_id`, `option_value_id`),
  FOREIGN KEY (`variant_id`) REFERENCES `shop_product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`option_value_id`) REFERENCES `shop_product_option_values`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_inventory_items` (
  `id` text PRIMARY KEY NOT NULL,
  `variant_id` text NOT NULL,
  `tracked` integer DEFAULT true NOT NULL,
  `cost_satang` integer,
  `continue_selling_when_out_of_stock` integer DEFAULT false NOT NULL,
  FOREIGN KEY (`variant_id`) REFERENCES `shop_product_variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_inventory_items_variant_id_unique` ON `shop_inventory_items` (`variant_id`);
--> statement-breakpoint

CREATE TABLE `shop_inventory_levels` (
  `item_id` text NOT NULL,
  `location_id` text DEFAULT 'default' NOT NULL,
  `on_hand` integer DEFAULT 0 NOT NULL,
  `reserved` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(`item_id`, `location_id`),
  FOREIGN KEY (`item_id`) REFERENCES `shop_inventory_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_collections` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `kind` text DEFAULT 'manual' NOT NULL,
  `rules_json` text,
  `featured_media_id` text,
  `seo_title` text,
  `seo_description` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_collections_slug_unique` ON `shop_collections` (`slug`);
--> statement-breakpoint

CREATE TABLE `shop_collection_localizations` (
  `collection_id` text NOT NULL,
  `locale` text NOT NULL,
  `title` text NOT NULL,
  `description_markdown` text,
  PRIMARY KEY(`collection_id`, `locale`),
  FOREIGN KEY (`collection_id`) REFERENCES `shop_collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `shop_collection_products` (
  `collection_id` text NOT NULL,
  `product_id` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(`collection_id`, `product_id`),
  FOREIGN KEY (`collection_id`) REFERENCES `shop_collections`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade
);
