-- @khaopad/plugin-shop v0.5.0 — cart recovery-email bookkeeping.
-- One-shot column so the abandoned-cart sweep doesn't re-email a
-- cart on every tick. NULL = never sent; ISO timestamp = sent at
-- that moment.

ALTER TABLE `shop_carts` ADD COLUMN `recovery_email_sent_at` text;
