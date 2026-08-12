-- v4.0.1 audit C1/C2 — externally-pushed order items get a stable,
-- REPLAYABLE identity.
--
-- Background: an external (POS) order's header and its line items are
-- separate D1 statements, and the items insert is itself chunked at 9
-- rows. A crash mid-chunk left a partially-written receipt, and two
-- concurrent deliveries of the same push could each insert a full set
-- of lines — 24 rows for a 12-line receipt, plus a double inventory
-- deduction.
--
-- The application now derives item ids deterministically as
-- `ext:<order_id>:<line_index>` (externalOrderItemId in
-- order-service.ts), so a replay of the same payload re-derives the
-- same primary keys and collides instead of duplicating.
-- shop_order_items.id is already the PRIMARY KEY, which IS the
-- uniqueness mechanism; this index exists so the (order_id, id) pair
-- an external repair looks up is covered, and so the intent is
-- recorded in the schema rather than only in application code.
--
-- A UNIQUE(order_id, variant_id) was considered and REJECTED: a POS
-- receipt may legitimately carry the same SKU on two lines (two scans
-- at different counter prices), and such a constraint would reject
-- valid receipts. Native (cart-derived) orders dedupe by variant in
-- cart-service.addItem, so they would satisfy it — but the external
-- flow would not.

CREATE INDEX IF NOT EXISTS `shop_order_items_order_id_idx`
  ON `shop_order_items` (`order_id`, `id`);
