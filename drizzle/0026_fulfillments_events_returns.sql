-- @khaopad/plugin-shop v0.7.0 — Phase C operations tables (C1/C2/C10).
-- Design in src/plugins/shop/schema-operations.ts.
--
-- 1. shop_fulfillments — row-per-shipment (carrier preset id from
--    carriers.ts + tracking number). One row per order today; the
--    row-per-shipment shape means partial fulfillment later needs no
--    migration. `notified_at` marks the "shipped" email as sent.
--
-- 2. shop_order_events — append-only order timeline (C2). Written by
--    every lifecycle transition in order-service.ts plus admin
--    free-text notes. Never updated, never deleted. The B6 refund
--    `reason` finally becomes visible here.
--
-- 3. shop_returns — returns v1 state machine (C10):
--    requested → approved → received → refunded, with rejected
--    reachable from requested/approved. Drives shop_orders.return_status
--    (#109): requested/approved/received map 1:1; refunded and rejected
--    both map to 'resolved'. Money stays in the adjustments ledger.

CREATE TABLE `shop_fulfillments` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `carrier` text,
  `tracking_number` text,
  `fulfilled_at` text NOT NULL,
  `notified_at` text,
  FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shop_fulfillments_order_id_idx` ON `shop_fulfillments` (`order_id`);
--> statement-breakpoint

CREATE TABLE `shop_order_events` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `kind` text NOT NULL,
  `message` text,
  `actor_email` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shop_order_events_order_created_idx` ON `shop_order_events` (`order_id`,`created_at`);
--> statement-breakpoint

CREATE TABLE `shop_returns` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `state` text NOT NULL,
  `reason_text` text,
  `items_json` text,
  `created_at` text NOT NULL,
  `resolved_at` text,
  FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shop_returns_order_id_idx` ON `shop_returns` (`order_id`);
