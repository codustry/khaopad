-- v4.1 D7 (#165) — fixed product bundles.
--
-- A bundle is an ORDINARY variant that happens to have component rows
-- pointing at other variants. That choice is deliberate and load-
-- bearing:
--
--   * The bundle carries its own `price_satang`, so every existing
--     money path (totals.ts, cart snapshots, order line snapshots,
--     discounts, tax) works untouched. The bundle price is FIXED and
--     AUTHORITATIVE — it is NEVER recomputed as the sum of its
--     components, at checkout or anywhere else. An order is an
--     immutable financial record; re-deriving a historical bundle
--     price from today's component prices would rewrite the books.
--
--   * The bundle needs no inventory rows of its own. Its purchasable
--     quantity is DERIVED: min over components of
--     floor(component.available / quantity_per_bundle). Storing a
--     bundle on_hand would be a second source of truth that drifts
--     from its components on the first POS sale.
--
-- `is_bundle` on shop_products is the marker the admin UI and the
-- storefront read. It lives on the PRODUCT (not the variant) because
-- "this is a bundle" is a product-type decision the merchant makes
-- once; a product's variants are all bundles or none are.
--
-- Recursion (a bundle whose component is itself a bundle) is REJECTED
-- in the service layer (assertNotBundleComponent in bundles.ts) rather
-- than by a constraint: SQLite cannot express "the product owning this
-- variant must not be a bundle" without a trigger, and a trigger would
-- be invisible to the test suite that has to pin this behaviour.
-- Unbounded expansion is the failure mode being prevented, so the rule
-- is one level deep by construction.

ALTER TABLE `shop_products` ADD COLUMN `is_bundle` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shop_bundle_components` (
	`bundle_variant_id` text NOT NULL,
	`component_variant_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`bundle_variant_id`, `component_variant_id`),
	FOREIGN KEY (`bundle_variant_id`) REFERENCES `shop_product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	-- RESTRICT, matching shop_order_items.variant_id: a component
	-- variant that a live bundle depends on must not vanish underneath
	-- it. Deleting the component's product is blocked until the
	-- merchant removes it from the bundle.
	FOREIGN KEY (`component_variant_id`) REFERENCES `shop_product_variants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- The reverse lookup: "which bundles would this variant's stock
-- change affect?" — used by availability reads and by the admin's
-- component picker to warn before archiving a depended-on variant.
CREATE INDEX IF NOT EXISTS `shop_bundle_components_component_idx`
  ON `shop_bundle_components` (`component_variant_id`);
