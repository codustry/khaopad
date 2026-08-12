-- v4.0 #160 Phase E-1 — Tonbab commerce sync (Khao Pad half).
--
-- 1. External identity on orders: POS/marketplace orders pushed into
--    Khao Pad carry the origin system + its order id. The partial
--    UNIQUE index makes replays of the same (source, external_id)
--    idempotent at the DB layer — native orders (both columns NULL)
--    are unconstrained.
-- 2. sync_log: append-only audit of every sync item processed, both
--    directions, for the /admin/settings/connections status panel.

ALTER TABLE `shop_orders` ADD `external_source` text;
--> statement-breakpoint
ALTER TABLE `shop_orders` ADD `external_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_orders_external_source_id_uq`
  ON `shop_orders` (`external_source`, `external_id`)
  WHERE `external_source` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `sync_log` (
  `id` text PRIMARY KEY NOT NULL,
  `source` text NOT NULL,
  `direction` text NOT NULL,
  `external_id` text,
  `action` text NOT NULL,
  `result` text NOT NULL,
  `detail` text,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_log_source_created_idx` ON `sync_log` (`source`, `created_at`);
