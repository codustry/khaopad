-- @khaopad/plugin-shop v0.6.0 — order status axes + adjustments ledger (#109, #110).
-- Design in src/plugins/shop/schema-cart.ts.
--
-- 1. Splits the single-axis order `status` into three orthogonal axes:
--      financial_status   pending | paid | partially_refunded | refunded | cancelled
--      fulfillment_status unfulfilled | fulfilled | delivered
--      return_status      NULL | requested | approved | received | resolved
--    The legacy `status` column is KEPT and derived on every write
--    (deriveLegacyStatus in order-service.ts) so existing reads —
--    funnel pages, admin lists, the status endpoint — keep working
--    until the UI migrates in Phase C.
--
-- 2. `channel` is Phase E groundwork ('tonbab_pos' | 'marketplace'
--    arrive later) — added now so it is one migration, not two.
--
-- 3. shop_order_adjustments becomes the authoritative refund ledger:
--    refunded totals are derived by summing rows, never by mutating a
--    counter. `idempotency_key` (UNIQUE where present) makes a webhook
--    or double-click replay a no-op; `provider_refund_id` records the
--    gateway's transaction id for reconciliation.
--
-- 4. shop_order_items.discount_allocated_satang carries the per-line
--    discount allocation (pure allocateDiscount(), B1–B4).

ALTER TABLE `shop_orders` ADD COLUMN `financial_status` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE `shop_orders` ADD COLUMN `fulfillment_status` text DEFAULT 'unfulfilled' NOT NULL;
--> statement-breakpoint
ALTER TABLE `shop_orders` ADD COLUMN `return_status` text;
--> statement-breakpoint
ALTER TABLE `shop_orders` ADD COLUMN `channel` text DEFAULT 'online_store' NOT NULL;
--> statement-breakpoint

-- Backfill the axes from the legacy single-axis status.
--   pending   → pending   / unfulfilled
--   paid      → paid      / unfulfilled
--   fulfilled → paid      / fulfilled
--   delivered → paid      / delivered
--   refunded  → refunded  / keep whatever fulfillment progress the
--                           timestamps prove (fulfilled_at/delivered_at)
--   cancelled → cancelled / unfulfilled
UPDATE `shop_orders` SET
  `financial_status` = CASE `status`
    WHEN 'pending' THEN 'pending'
    WHEN 'refunded' THEN 'refunded'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'paid'
  END,
  `fulfillment_status` = CASE
    WHEN `status` = 'delivered' THEN 'delivered'
    WHEN `status` = 'fulfilled' THEN 'fulfilled'
    -- refunded orders lost their fulfillment axis in the legacy model;
    -- recover it from the transition timestamps.
    WHEN `status` = 'refunded' AND `delivered_at` IS NOT NULL THEN 'delivered'
    WHEN `status` = 'refunded' AND `fulfilled_at` IS NOT NULL THEN 'fulfilled'
    ELSE 'unfulfilled'
  END;
--> statement-breakpoint

ALTER TABLE `shop_order_adjustments` ADD COLUMN `provider_refund_id` text;
--> statement-breakpoint
ALTER TABLE `shop_order_adjustments` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
-- Partial index: only rows that carry a key participate in dedupe;
-- legacy rows (NULL) never collide with each other.
CREATE UNIQUE INDEX `shop_order_adjustments_idempotency_key_idx`
  ON `shop_order_adjustments` (`idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `shop_order_items` ADD COLUMN `discount_allocated_satang` integer DEFAULT 0 NOT NULL;
