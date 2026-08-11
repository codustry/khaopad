-- @khaopad/plugin-shop v0.7.0 — automatic discounts (D3) + finance/tax groundwork (D5).
-- Design in src/plugins/shop/schema-discount.ts and schema-cart.ts.
--
-- 1. `shop_discount_codes.method`: 'code' (customer types it) vs
--    'automatic' (evaluated for every checkout while active). All
--    existing rows are typed codes → DEFAULT 'code'.
--
--    `code` stays NOT NULL on purpose. SQLite cannot drop NOT NULL via
--    ALTER; the alternatives were a full table swap (copy + rename,
--    risky on a table with a FK from shop_discount_redemptions) or a
--    sentinel. We take the sentinel: automatic rows get an
--    auto-generated `AUTO-<nanoid>` code (createDiscount in
--    discount-service.ts). The sentinel keeps the UNIQUE index
--    satisfied, keeps the webhook's `<discountId>:<code>` cart stash
--    format working unchanged, and validateDiscount() filters on
--    method='code' so a leaked sentinel can never be typed in at
--    checkout.
--
-- 2. shop_orders gains the two fields the finance report needs to
--    label VAT correctly per order (D5):
--      tax_included_satang — VAT already contained in the total
--                            (prices-inclusive mode; computeTotals'
--                            taxIncludedSatang, previously computed
--                            but never persisted)
--      tax_mode            — 'exclusive' | 'inclusive' snapshot of the
--                            store's tax config at checkout time, so a
--                            later config flip doesn't rewrite history.
--    Backfill: existing rows keep tax_included_satang=0 / 'exclusive'.
--    Rows created before this migration in inclusive mode have
--    tax_satang=0 and no way to recover the included VAT without the
--    rate history — the report labels pre-0028 inclusive VAT as 0 and
--    the ใบกำกับภาษี groundwork only applies going forward.

ALTER TABLE `shop_discount_codes` ADD COLUMN `method` text DEFAULT 'code' NOT NULL;
--> statement-breakpoint
ALTER TABLE `shop_orders` ADD COLUMN `tax_included_satang` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `shop_orders` ADD COLUMN `tax_mode` text DEFAULT 'exclusive' NOT NULL;
