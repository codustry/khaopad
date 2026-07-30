/**
 * Collection registry — Phase 2 (#68 §B, as corrected).
 *
 * A DB-stored meta-schema so new content types and fields are **data,
 * not code**. Adding a user collection is an INSERT; it needs no
 * migration and no deploy. The engine tables below are themselves
 * ordinary Drizzle migrations — there is no runtime DDL for *these*.
 *
 * ## Why this shape (and why the earlier verdict was reversed)
 *
 * Issue #68 carried a 2026-07-28 verdict that overturned this design in
 * favour of code-first tables. Re-research (see the correction comment
 * on #68) found all three of its pillars failed:
 *
 *  1. "Cloudflare discourages runtime DDL" — the quote it relied on is
 *     not in current docs; today's wording narrows the rationale to
 *     REST-API rate limits.
 *  2. "Payload proves code-first buys real SQL joins" — reading shipped
 *     source, Payload folds a relation into its join tree only when the
 *     relation is single-valued AND monomorphic, and its list path
 *     hardcodes depth 0. For `hasMany` — every catalog relation — it
 *     also issues follow-up queries. Batched populate is required
 *     either way, which is why Phase 1 stands independent of this.
 *  3. "wp_postmeta is the cautionary tale" — that argues against a
 *     schema nobody proposed. wp_postmeta puts every *field* in a row,
 *     so filtering on N fields costs N self-joins on one untyped
 *     column. Here, an entry's scalars are **one JSON document**: zero
 *     joins to read them. Karwin's canonical anti-EAV essay lists
 *     "serialized LOB with an inverted index" among its *recommended*
 *     alternatives — which is exactly this. Akeneo migrated *toward*
 *     this shape in 2.0, keeping definitions relational and values in
 *     JSON.
 *
 * The inverted index is `entry_field_index` plus, for hot fields,
 * VIRTUAL generated columns promoted at runtime (see promote.ts) — a
 * pattern Cloudflare explicitly recommends.
 *
 * ## The one constraint to design around
 *
 * Not join explosion — **D1's 100-column-per-table ceiling**. It bounds
 * how many fields can be promoted to generated columns on `entries`.
 * SonicJS, which ships this design on D1, flags the same wall. Hence
 * `promoted` is opt-in per field, never automatic.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── Collections (the meta-schema) ──────────────────────────

/**
 * A user-defined content type.
 *
 * `kind`:
 *  - `collection` — many entries (Article, Product, Brand)
 *  - `single`     — exactly one entry (Homepage, Settings); enforced in
 *                   the service layer, not by a DB constraint, because
 *                   SQLite can't express "at most one row per FK value"
 *                   without a trigger
 *  - `component`  — never addressable on its own; only ever nested
 *                   inside another entry's field. This is how blocks
 *                   and dynamic zones are modelled (#68 §C).
 */
export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    /**
     * Stable machine name used in API paths and populate params.
     * Immutable after creation — renaming would silently break every
     * consumer's saved queries, so the service rejects it.
     */
    apiId: text("api_id").notNull().unique(),
    kind: text("kind", { enum: ["collection", "single", "component"] })
      .notNull()
      .default("collection"),
    /** Per-locale display labels, JSON: `{"en":{"singular":…,"plural":…}}` */
    labelsJson: text("labels_json"),
    /** When false, every entry is immediately live (no draft state). */
    draftPublish: integer("draft_publish", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * Whether entries carry per-locale content at all. A taxonomy of
     * machine keys may not need it.
     */
    localized: integer("localized", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * Engine-owned collections (if any are ever registered here) must
     * not be editable or deletable from the admin UI.
     */
    system: integer("system", { mode: "boolean" }).notNull().default(false),
    description: text("description"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    kindIdx: index("collections_kind_idx").on(t.kind),
  }),
);

/**
 * Field types. Deliberately closed: the admin UI maps each to exactly
 * one editor component (Phase 4), and a `find()` filter has to know how
 * to compare the value.
 *
 * `relation` and `component` store nothing in the entry document —
 * their values live in `entry_relations` so they stay independently
 * queryable and orderable.
 */
export const FIELD_TYPES = [
  "text",
  "richtext",
  "number",
  "boolean",
  "date",
  "datetime",
  "email",
  "url",
  "slug",
  "enum",
  "json",
  "media",
  "relation",
  "component",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const collectionFields = sqliteTable(
  "collection_fields",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** Machine name; the key inside the entry's JSON document. */
    apiId: text("api_id").notNull(),
    type: text("type", { enum: FIELD_TYPES }).notNull(),
    labelsJson: text("labels_json"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    /**
     * When true the value lives in `entry_localizations.dataJson` per
     * locale; when false it lives once in `entries.dataJson`. Per-field,
     * so a Product can have a localized `name` and a shared `sku`.
     */
    localized: integer("localized", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * Uniqueness is enforced in the service layer, not by a DB
     * constraint — the value lives inside a JSON document, so there is
     * no column to put a UNIQUE index on. Promoting the field (below)
     * does make a real unique index possible.
     */
    unique: integer("unique", { mode: "boolean" }).notNull().default(false),
    /**
     * Opt into a VIRTUAL generated column + index on this field, making
     * it efficiently filterable and sortable.
     *
     * Opt-in rather than automatic because D1 caps a table at 100
     * columns: every promotion spends part of a fixed budget shared by
     * all collections on the `entries` table.
     */
    promoted: integer("promoted", { mode: "boolean" }).notNull().default(false),
    /**
     * Type-specific settings as JSON — enum options, min/max, relation
     * target + cardinality, allowed component collections for a
     * dynamic zone, etc. Validated per `type` by the service.
     */
    configJson: text("config_json"),
    /** Display order in the admin form. */
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    // A field's apiId must be unique within its collection — two
    // fields both writing `data.title` would silently overwrite.
    collectionApiIdx: uniqueIndex("collection_fields_collection_api_idx").on(
      t.collectionId,
      t.apiId,
    ),
    positionIdx: index("collection_fields_position_idx").on(
      t.collectionId,
      t.position,
    ),
  }),
);

// ─── Entries (the content) ──────────────────────────────────

/**
 * One row per entry, whatever its collection.
 *
 * Non-localized scalars live in `dataJson`. This is the "serialized
 * LOB" — reading an entry's scalars is one row read and zero joins,
 * which is precisely what distinguishes this from per-field EAV.
 *
 * Promoted fields get VIRTUAL generated columns added to THIS table at
 * runtime (`promote.ts`). They are not declared here because they are
 * per-installation: which ones exist depends on the registry rows a
 * given site created.
 */
export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /**
     * Shared across locales and unique within the collection, matching
     * the repo's existing slug convention (English-derived ASCII, no
     * per-locale slug). Null for `component` entries, which are never
     * addressed by URL.
     */
    slug: text("slug"),
    status: text("status", { enum: ["draft", "published", "archived"] })
      .notNull()
      .default("draft"),
    publishedAt: text("published_at"),
    /** Non-localized field values, JSON object keyed by field apiId. */
    dataJson: text("data_json").notNull().default("{}"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    // Slug uniqueness is scoped to the collection: two different types
    // may both legitimately have an "about" entry.
    collectionSlugIdx: uniqueIndex("entries_collection_slug_idx").on(
      t.collectionId,
      t.slug,
    ),
    // The list query: entries of one type, by status, newest first.
    listIdx: index("entries_collection_status_idx").on(
      t.collectionId,
      t.status,
      t.updatedAt,
    ),
    publishedIdx: index("entries_published_idx").on(
      t.collectionId,
      t.publishedAt,
    ),
  }),
);

/**
 * Per-locale field values. One row per (entry, locale).
 *
 * `locale` is **plain text, deliberately not an enum** — #68 §E. The
 * existing content tables bake `["th","en"]` into ~8 schemas, so adding
 * a locale means a migration everywhere. Here it's validated against
 * the runtime supported-locale list instead.
 */
export const entryLocalizations = sqliteTable(
  "entry_localizations",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    /** Localized field values, JSON object keyed by field apiId. */
    dataJson: text("data_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    entryLocaleIdx: uniqueIndex("entry_localizations_entry_locale_idx").on(
      t.entryId,
      t.locale,
    ),
  }),
);

// ─── Relations ──────────────────────────────────────────────

/**
 * ONE join table for every entry→entry relation — 1:1, 1:n and n:m
 * alike (#68 §C). Cardinality is declared in the field's `configJson`
 * and enforced by the service; the storage shape is identical.
 *
 * `position` gives ordered relations, which the existing `article_tags`
 * table cannot express. A catalog needs it (a Brand's ProductLines have
 * a curated order), and so do dynamic zones, where the order of nested
 * component entries *is* the page layout.
 */
export const entryRelations = sqliteTable(
  "entry_relations",
  {
    id: text("id").primaryKey(),
    /** The entry that owns the relation field. */
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    /**
     * Which field on the owner this edge belongs to. Stored as the
     * field's apiId rather than its row id so an edge stays readable
     * (and debuggable) without joining the registry.
     */
    fieldApiId: text("field_api_id").notNull(),
    /**
     * Which shape this edge's target takes (#99).
     *
     *   `entry`    — points at an entry we own; `targetEntryId` is set
     *   `external` — points at something the CMS does NOT own;
     *                `targetNamespace` + `targetRef` are set
     *
     * The external case exists because forcing every target to be an
     * entry means creating shell entries for data you merely reference
     * — which both implies you manage it and pollutes the collection it
     * lands in. A CHECK constraint enforces exactly one shape.
     */
    targetKind: text("target_kind", { enum: ["entry", "external"] })
      .notNull()
      .default("entry"),
    /**
     * The target entry. CASCADE, so deleting an entry removes the edges
     * pointing at it rather than leaving dangling references that
     * populate would have to filter out on every read.
     *
     * Nullable since #99 — null exactly when `targetKind='external'`.
     */
    targetEntryId: text("target_entry_id").references(() => entries.id, {
      onDelete: "cascade",
    }),
    /**
     * Governing namespace for an external target — e.g. a manufacturer
     * key. Deliberately a plain string rather than an FK: the namespace
     * side *should* be modelled as a normal user collection when it
     * needs governance, leaving only the far-side identifier
     * unmanaged (#99).
     */
    targetNamespace: text("target_namespace"),
    /** Identifier within the namespace — a model number, SKU, ISBN. */
    targetRef: text("target_ref"),
    /** Optional display override; falls back to `targetRef`. */
    targetLabel: text("target_label"),
    position: integer("position").notNull().default(0),
    /**
     * Edge attributes (#99) — data belonging to the PAIRING rather than
     * to either endpoint. A confidence tier on a "replaces" edge, a
     * `quantity` on a bill-of-materials edge, `valid_from`/`valid_until`
     * on a supersession, a `role` on person↔project.
     *
     * Opt-in: validated against a JSON schema declared on the relation
     * field's `config.edgeFields` in `collection_fields`, and left null
     * for relations that carry no edge data, so containment relations
     * pay nothing.
     */
    dataJson: text("data_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    // Forward traversal: "this entry's `variants`, in order" — the
    // query populate issues on every read.
    forwardIdx: index("entry_relations_forward_idx").on(
      t.entryId,
      t.fieldApiId,
      t.position,
    ),
    // Reverse traversal: "what points at this entry?" Needed for
    // reverse/join fields and for invalidating caches on target edit.
    reverseIdx: index("entry_relations_reverse_idx").on(
      t.targetEntryId,
      t.fieldApiId,
    ),
    // Reverse lookup for EXTERNAL targets: "which entries reference
    // busch/R5-KA-0100?" — powers cross-reference landing pages (#99).
    externalIdx: index("entry_relations_external_idx").on(
      t.targetNamespace,
      t.targetRef,
    ),
    // The same edge must not exist twice on one field.
    //
    // Two indexes rather than one, because `targetEntryId` became
    // nullable in #99 and SQLite treats NULLs as DISTINCT in a UNIQUE
    // index — a single index spanning both shapes would silently stop
    // constraining the external case, exactly the trap that made
    // `attribute_values.locale` unenforceable before it was fixed.
    //
    // Each index is PARTIAL (`WHERE target_kind = …`) so the column it
    // keys on is guaranteed non-null within its own scope.
    uniqueEntryEdge: uniqueIndex("entry_relations_unique_edge_idx")
      .on(t.entryId, t.fieldApiId, t.targetEntryId)
      .where(sql`${t.targetKind} = 'entry'`),
    uniqueExternalEdge: uniqueIndex("entry_relations_unique_external_idx")
      .on(t.entryId, t.fieldApiId, t.targetNamespace, t.targetRef)
      .where(sql`${t.targetKind} = 'external'`),
  }),
);

// ─── Inverted index for non-promoted fields ─────────────────

/**
 * Sparse index over field values that are filtered but not promoted to
 * a generated column.
 *
 * This is the "inverted index" half of Karwin's serialized-LOB
 * recommendation, and the reason this design is not wp_postmeta: rows
 * here are written **only** for fields explicitly marked filterable,
 * and reading an entry never touches this table — the document in
 * `entries.dataJson` is the source of truth. It is a lookup structure,
 * not the storage.
 *
 * Values are split by type so comparisons stay typed: SQLite would
 * otherwise compare "9" > "100" as text, which is the specific failure
 * that makes an untyped `meta_value` column useless for faceting.
 */
export const entryFieldIndex = sqliteTable(
  "entry_field_index",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    fieldApiId: text("field_api_id").notNull(),
    /** Null for non-localized fields. */
    locale: text("locale"),
    valueText: text("value_text"),
    valueNumber: integer("value_number"),
    valueBool: integer("value_bool", { mode: "boolean" }),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.entryId, t.fieldApiId, t.locale],
    }),
    // Facet/filter: "entries where field X = / < / between …".
    textLookupIdx: index("entry_field_index_text_idx").on(
      t.fieldApiId,
      t.valueText,
    ),
    numberLookupIdx: index("entry_field_index_number_idx").on(
      t.fieldApiId,
      t.valueNumber,
    ),
  }),
);

// ─── Versions ───────────────────────────────────────────────

/**
 * Generalizes `article_versions` (#68 §F). Snapshots the whole entry —
 * document, localizations and relation edges — so a restore is exact
 * rather than best-effort.
 */
export const entryVersions = sqliteTable(
  "entry_versions",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    /** Full snapshot: `{data, localizations, relations}`. */
    snapshotJson: text("snapshot_json").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    entryIdx: index("entry_versions_entry_idx").on(t.entryId, t.createdAt),
  }),
);

// ─── Type exports ───────────────────────────────────────────

export type Collection = typeof collections.$inferSelect;
export type CollectionField = typeof collectionFields.$inferSelect;
export type Entry = typeof entries.$inferSelect;
export type EntryLocalization = typeof entryLocalizations.$inferSelect;
export type EntryRelation = typeof entryRelations.$inferSelect;
export type EntryFieldIndexRow = typeof entryFieldIndex.$inferSelect;
export type EntryVersion = typeof entryVersions.$inferSelect;
