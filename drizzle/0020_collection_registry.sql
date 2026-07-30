-- Phase 2 of #68 — collection registry: user-definable content types.
--
-- These are ENGINE tables and ship as an ordinary migration. What they
-- make dynamic is *user* collections: adding a content type after this
-- lands is an INSERT into `collections` + `collection_fields`, with no
-- migration and no deploy.
--
-- Storage shape: one row per entry with its non-localized scalars in a
-- single `data_json` document, per-locale scalars in
-- `entry_localizations.data_json`, and ALL relations (1:1 / 1:n / n:m,
-- ordered) in the single `entry_relations` table.
--
-- Note `locale` is plain TEXT, deliberately not a CHECK-constrained
-- enum: the existing content tables bake ("th","en") into ~8 schemas so
-- adding a locale means a migration everywhere. Here it is validated
-- against the runtime supported-locale list instead.

CREATE TABLE `collections` (
  `id` text PRIMARY KEY NOT NULL,
  `api_id` text NOT NULL,
  `kind` text DEFAULT 'collection' NOT NULL,
  `labels_json` text,
  `draft_publish` integer DEFAULT true NOT NULL,
  `localized` integer DEFAULT true NOT NULL,
  `system` integer DEFAULT false NOT NULL,
  `description` text,
  `created_by` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_api_id_unique` ON `collections` (`api_id`);--> statement-breakpoint
CREATE INDEX `collections_kind_idx` ON `collections` (`kind`);--> statement-breakpoint

CREATE TABLE `collection_fields` (
  `id` text PRIMARY KEY NOT NULL,
  `collection_id` text NOT NULL,
  `api_id` text NOT NULL,
  `type` text NOT NULL,
  `labels_json` text,
  `required` integer DEFAULT false NOT NULL,
  `localized` integer DEFAULT false NOT NULL,
  `unique` integer DEFAULT false NOT NULL,
  `promoted` integer DEFAULT false NOT NULL,
  `config_json` text,
  `position` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Two fields writing the same document key would silently overwrite.
CREATE UNIQUE INDEX `collection_fields_collection_api_idx` ON `collection_fields` (`collection_id`,`api_id`);--> statement-breakpoint
CREATE INDEX `collection_fields_position_idx` ON `collection_fields` (`collection_id`,`position`);--> statement-breakpoint

CREATE TABLE `entries` (
  `id` text PRIMARY KEY NOT NULL,
  `collection_id` text NOT NULL,
  `slug` text,
  `status` text DEFAULT 'draft' NOT NULL,
  `published_at` text,
  `data_json` text DEFAULT '{}' NOT NULL,
  `created_by` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Slug uniqueness is scoped to the collection: two types may both
-- legitimately have an "about" entry.
CREATE UNIQUE INDEX `entries_collection_slug_idx` ON `entries` (`collection_id`,`slug`);--> statement-breakpoint
CREATE INDEX `entries_collection_status_idx` ON `entries` (`collection_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `entries_published_idx` ON `entries` (`collection_id`,`published_at`);--> statement-breakpoint

CREATE TABLE `entry_localizations` (
  `id` text PRIMARY KEY NOT NULL,
  `entry_id` text NOT NULL,
  `locale` text NOT NULL,
  `data_json` text DEFAULT '{}' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entry_localizations_entry_locale_idx` ON `entry_localizations` (`entry_id`,`locale`);--> statement-breakpoint

-- ONE join table for every entry→entry relation. `position` gives
-- ordered relations, which the existing `article_tags` cannot express —
-- a catalog needs it, and for a dynamic zone the order of nested
-- component entries IS the page layout.
CREATE TABLE `entry_relations` (
  `id` text PRIMARY KEY NOT NULL,
  `entry_id` text NOT NULL,
  `field_api_id` text NOT NULL,
  -- #99: an edge targets either an entry we own or an EXTERNAL reference.
  -- Forcing everything to be an entry means creating shell entries for
  -- data you merely reference, which implies you manage it.
  `target_kind` text DEFAULT 'entry' NOT NULL,
  `target_entry_id` text,
  `target_namespace` text,
  `target_ref` text,
  `target_label` text,
  `position` integer DEFAULT 0 NOT NULL,
  -- #99: edge attributes — data belonging to the PAIRING, not to either
  -- endpoint (a confidence tier on "replaces", a quantity on a BOM edge).
  -- Opt-in; null for containment relations, which pay nothing.
  `data_json` text,
  `created_at` text NOT NULL,
  -- Exactly one target shape must be populated. Without this, a row can
  -- claim to be external while carrying an entry id, and populate would
  -- have to guess which to trust.
  CONSTRAINT `entry_relations_target_shape` CHECK (
    (`target_kind` = 'entry'
       AND `target_entry_id` IS NOT NULL
       AND `target_namespace` IS NULL
       AND `target_ref` IS NULL)
    OR
    (`target_kind` = 'external'
       AND `target_entry_id` IS NULL
       AND `target_namespace` IS NOT NULL
       AND `target_ref` IS NOT NULL)
  ),
  FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`target_entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Forward: "this entry's `variants`, in order" — issued on every read.
CREATE INDEX `entry_relations_forward_idx` ON `entry_relations` (`entry_id`,`field_api_id`,`position`);--> statement-breakpoint
-- Reverse: "what points at this entry?" — reverse/join fields, and
-- cache invalidation when a target is edited.
CREATE INDEX `entry_relations_reverse_idx` ON `entry_relations` (`target_entry_id`,`field_api_id`);--> statement-breakpoint
-- Reverse lookup for external targets: "which entries reference
-- <namespace>/<ref>?" — powers cross-reference landing pages.
CREATE INDEX `entry_relations_external_idx` ON `entry_relations` (`target_namespace`,`target_ref`);--> statement-breakpoint
-- Uniqueness is TWO PARTIAL indexes, not one spanning index. Since #99
-- made target_entry_id nullable and SQLite treats NULLs as DISTINCT in a
-- UNIQUE index, a single index covering both shapes would silently stop
-- constraining the external case. Each partial index keys only on
-- columns guaranteed non-null within its own WHERE scope.
CREATE UNIQUE INDEX `entry_relations_unique_edge_idx` ON `entry_relations` (`entry_id`,`field_api_id`,`target_entry_id`) WHERE `target_kind` = 'entry';--> statement-breakpoint
CREATE UNIQUE INDEX `entry_relations_unique_external_idx` ON `entry_relations` (`entry_id`,`field_api_id`,`target_namespace`,`target_ref`) WHERE `target_kind` = 'external';--> statement-breakpoint

-- Sparse inverted index over filterable, non-promoted field values.
--
-- This is what makes the design NOT wp_postmeta: rows exist only for
-- fields explicitly marked filterable, and reading an entry never
-- touches this table — `entries.data_json` is the source of truth. It's
-- a lookup structure, not the storage.
--
-- Values are split by type because SQLite would otherwise compare
-- "9" > "100" as text, the exact failure that makes an untyped
-- `meta_value` column useless for faceting.
CREATE TABLE `entry_field_index` (
  `entry_id` text NOT NULL,
  `field_api_id` text NOT NULL,
  `locale` text,
  `value_text` text,
  `value_number` integer,
  `value_bool` integer,
  PRIMARY KEY (`entry_id`, `field_api_id`, `locale`),
  FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entry_field_index_text_idx` ON `entry_field_index` (`field_api_id`,`value_text`);--> statement-breakpoint
CREATE INDEX `entry_field_index_number_idx` ON `entry_field_index` (`field_api_id`,`value_number`);--> statement-breakpoint

-- Generalizes `article_versions` (#68 §F) to every content type.
-- Snapshots document + localizations + relation edges so a restore is
-- exact rather than best-effort.
CREATE TABLE `entry_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `entry_id` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `created_by` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entry_versions_entry_idx` ON `entry_versions` (`entry_id`,`created_at`);
