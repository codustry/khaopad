-- Link each stock hold to the order it was taken for (v4.6.0).
--
-- Holds expire after 15 minutes, but a QR stays payable for 30 and a
-- payment link for 60. Without this column a late payment could not
-- tell whether ITS hold had already lapsed, so it always decremented
-- `reserved` — eating another shopper's hold. Nullable: holds taken
-- before this migration (and carts that never became orders) stay NULL
-- and keep the old commit path.
ALTER TABLE `shop_inventory_reservations` ADD `order_id` text;
--> statement-breakpoint
CREATE INDEX `shop_inventory_reservations_order_idx` ON `shop_inventory_reservations` (`order_id`);
