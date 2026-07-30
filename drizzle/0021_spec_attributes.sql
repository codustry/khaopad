-- Phase 3 of #88 — typed spec/attribute layer.
--
-- Gives a catalog's leaf entity structured, unit-aware, QUERYABLE specs.
-- Rich text cannot back a datasheet: you can't sort a <div> by flow rate,
-- facet on "ultimate pressure < 0.1 mbar", or diff two variants
-- column-by-column.
--
-- Akeneo's three primitives, sized down for SQLite: definitions (what an
-- attribute is), families (which attributes a product type carries),
-- values (normalized, indexed).
--
-- On the EAV question: this is a NARROW, registry-disciplined table, not
-- the wp_postmeta pattern #68 rejected. Values are split into typed
-- columns so `value_number BETWEEN ?` compares as a number; every
-- attribute_id resolves to a typed definition so there is no free-text
-- meta_key to diverge; and cardinality is bounded by what a family
-- declares. Entry content itself still lives in entries.data_json.
--
-- Nothing here is client-specific. `entity_type` is free text, so values
-- attach to a Phase 2 registry entry, a shop variant, or anything else
-- with a stable id.

CREATE TABLE `attribute_definitions` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL,
  `data_type` text NOT NULL,
  `measure_family` text,
  `standard_unit` text,
  `options_json` text,
  `group_key` text,
  `position` integer DEFAULT 0 NOT NULL,
  `created_by` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attribute_definitions_key_unique` ON `attribute_definitions` (`key`);--> statement-breakpoint
CREATE INDEX `attribute_definitions_data_type_idx` ON `attribute_definitions` (`data_type`);--> statement-breakpoint
CREATE INDEX `attribute_definitions_group_idx` ON `attribute_definitions` (`group_key`,`position`);--> statement-breakpoint

-- Per-locale labels, following the repo's base-row + sibling
-- _localizations convention. `locale` is plain TEXT, not a CHECK enum —
-- same reasoning as Phase 2: the older content tables bake ("th","en")
-- into ~8 schemas, so adding a locale means a migration everywhere.
CREATE TABLE `attribute_definition_localizations` (
  `id` text PRIMARY KEY NOT NULL,
  `attribute_id` text NOT NULL,
  `locale` text NOT NULL,
  `label` text NOT NULL,
  `description` text,
  `option_labels_json` text,
  FOREIGN KEY (`attribute_id`) REFERENCES `attribute_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attribute_definition_localizations_attr_locale_idx` ON `attribute_definition_localizations` (`attribute_id`,`locale`);--> statement-breakpoint

-- A family is a named attribute set ('vacuum_pump', 'blower'). This is
-- the answer to "different product families have different specs":
-- distinct sets rather than one sparse wide table full of nulls.
CREATE TABLE `attribute_families` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL,
  `labels_json` text,
  `description` text,
  `created_by` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attribute_families_key_unique` ON `attribute_families` (`key`);--> statement-breakpoint

CREATE TABLE `family_attributes` (
  `family_id` text NOT NULL,
  `attribute_id` text NOT NULL,
  `required` integer DEFAULT false NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `is_variant_axis` integer DEFAULT false NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`family_id`, `attribute_id`),
  FOREIGN KEY (`family_id`) REFERENCES `attribute_families`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`attribute_id`) REFERENCES `attribute_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `family_attributes_family_order_idx` ON `family_attributes` (`family_id`,`sort_order`);--> statement-breakpoint
-- Reverse lookup: "which families use this attribute?" — checked before
-- allowing a definition to be deleted.
CREATE INDEX `family_attributes_attribute_idx` ON `family_attributes` (`attribute_id`);--> statement-breakpoint

-- Binds an entity to a family. Separate table because entities live in
-- several places (registry entries, shop variants) and none of them
-- should grow a column for this.
CREATE TABLE `entity_families` (
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `family_id` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`entity_type`, `entity_id`),
  FOREIGN KEY (`family_id`) REFERENCES `attribute_families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entity_families_family_idx` ON `entity_families` (`family_id`);--> statement-breakpoint

-- The values table.
--
-- `value_number` ALWAYS holds the standard-unit magnitude for
-- measurements, with `value_unit` preserving what the editor typed. That
-- split is what makes both of these correct at once:
--   facet/sort — WHERE attribute_id=? AND value_number BETWEEN ? AND ?
--                works across mixed authored units
--   display    — the datasheet still renders "0.1 mbar", not "10 Pa"
--
-- REAL, not INTEGER: vacuum pressures (1e-3 mbar) and small flows
-- (0.06 m3/h) need fractions.
CREATE TABLE `attribute_values` (
  `id` text PRIMARY KEY NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `attribute_id` text NOT NULL,
  `locale` text,
  `value_number` real,
  `value_unit` text,
  `value_text` text,
  `value_json` text,
  `value_bool` integer,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`attribute_id`) REFERENCES `attribute_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- One value per (entity, attribute, locale) — without this a second
-- write duplicates instead of updating, and a datasheet renders the
-- attribute twice.
CREATE UNIQUE INDEX `attribute_values_entity_attr_idx` ON `attribute_values` (`entity_type`,`entity_id`,`attribute_id`,`locale`);--> statement-breakpoint
-- Datasheet assembly: every value for one entity.
CREATE INDEX `attribute_values_entity_idx` ON `attribute_values` (`entity_type`,`entity_id`);--> statement-breakpoint
-- The index that makes "pumping speed 100-300 m3/h" an index seek
-- rather than a full scan.
CREATE INDEX `attribute_values_numeric_facet_idx` ON `attribute_values` (`attribute_id`,`value_number`);--> statement-breakpoint
CREATE INDEX `attribute_values_text_facet_idx` ON `attribute_values` (`attribute_id`,`value_text`);
