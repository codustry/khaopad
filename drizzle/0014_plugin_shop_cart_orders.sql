-- @khaopad/plugin-shop v0.2.0 — cart + reservation ledger + orders
-- Design decisions documented in src/plugins/shop/schema-cart.ts.
-- Six tables:
--   - shop_carts / shop_cart_items — session-cookie-scoped
--   - shop_inventory_reservations — 15-min TTL ledger for the sweep cron
--   - shop_orders / shop_order_items — with title/sku/price snapshot cols
--   - shop_order_adjustments — refunds, withholding tax, manual credits

CREATE TABLE `shop_carts` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text,
  `session_id` text NOT NULL,
  `previous_session_id` text,
  `email` text,
  `status` text DEFAULT 'open' NOT NULL,
  `checkout_started_at` text,
  `discount_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_carts_session_id_status_idx` ON `shop_carts` (`session_id`, `status`);
--> statement-breakpoint

CREATE TABLE `shop_cart_items` (
  `id` text PRIMARY KEY NOT NULL,
  `cart_id` text NOT NULL,
  `variant_id` text NOT NULL,
  `quantity` integer NOT NULL,
  `price_satang_at_add` integer NOT NULL,
  `added_at` text NOT NULL,
  FOREIGN KEY (`cart_id`) REFERENCES `shop_carts`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`variant_id`) REFERENCES `shop_product_variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint

CREATE TABLE `shop_inventory_reservations` (
  `id` text PRIMARY KEY NOT NULL,
  `cart_item_id` text NOT NULL,
  `variant_id` text NOT NULL,
  `quantity` integer NOT NULL,
  `reserved_at` text NOT NULL,
  `expires_at` text NOT NULL,
  `released_at` text,
  `release_reason` text
);
--> statement-breakpoint
-- Sweep cron looks up expired active reservations. Index the pattern.
CREATE INDEX `shop_reservations_active_idx` ON `shop_inventory_reservations` (`released_at`, `expires_at`);
--> statement-breakpoint

CREATE TABLE `shop_orders` (
  `id` text PRIMARY KEY NOT NULL,
  `order_number` text NOT NULL,
  `user_id` text,
  `email` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `provider_name` text,
  `provider_charge_id` text,
  `subtotal_satang` integer NOT NULL,
  `shipping_satang` integer DEFAULT 0 NOT NULL,
  `tax_satang` integer DEFAULT 0 NOT NULL,
  `discount_satang` integer DEFAULT 0 NOT NULL,
  `total_satang` integer NOT NULL,
  `shipping_address_json` text,
  `billing_address_json` text,
  `discount_code_snapshot` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `paid_at` text,
  `fulfilled_at` text,
  `delivered_at` text,
  `refunded_at` text,
  `cancelled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_orders_order_number_unique` ON `shop_orders` (`order_number`);
--> statement-breakpoint
-- Support lookups: guest order lookup by email + order number.
CREATE INDEX `shop_orders_email_idx` ON `shop_orders` (`email`);
--> statement-breakpoint

CREATE TABLE `shop_order_items` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `variant_id` text NOT NULL,
  `quantity` integer NOT NULL,
  `title_snapshot` text NOT NULL,
  `sku_snapshot` text,
  `price_snapshot_satang` integer NOT NULL,
  `line_subtotal_satang` integer NOT NULL,
  `line_tax_satang` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`variant_id`) REFERENCES `shop_product_variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint

CREATE TABLE `shop_order_adjustments` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `kind` text NOT NULL,
  `amount_satang` integer NOT NULL,
  `reason` text,
  `created_by` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
