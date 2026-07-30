/**
 * Typed spec/attribute layer — Phase 3 (#88 §C).
 *
 * The problem this solves, in #88's words: a catalog's leaf entity has
 * "no structured spec fields at all." Rich text cannot back a datasheet —
 * you can't sort a `<div>` by flow rate, facet on "ultimate pressure <
 * 0.1 mbar", or diff two variants column-by-column.
 *
 * Akeneo's three primitives, sized down for SQLite:
 *
 *   attribute_definitions  — WHAT an attribute is (typed, unit-aware)
 *   attribute_families     — WHICH attributes a product type carries
 *   attribute_values       — the values, normalized and queryable
 *
 * ## Why a narrow EAV here, when #68 rejected EAV
 *
 * These are not in tension. #68 rejected EAV as *general content
 * storage* — every field of every entry as a row, wp_postmeta-style,
 * where filtering N fields costs N self-joins on one untyped column.
 *
 * This table is different in the ways that caused that failure:
 *
 *   1. **Typed columns, not one `value` blob.** value_number / value_text
 *      / value_bool are separate, so `value_number BETWEEN ?` compares as
 *      a number. wp_postmeta's single LONGTEXT is what makes its indexes
 *      useless.
 *   2. **Registry-disciplined.** Every attribute_id resolves to a typed,
 *      family-scoped definition. There is no free-text `meta_key`, so
 *      "Flow rate" and "flow_rate" cannot diverge.
 *   3. **Bounded cardinality.** Rows exist only for attributes a family
 *      declares — tens per entity, not "whatever anyone wrote".
 *   4. **Not the primary read path.** An entry's own content still lives
 *      in `entries.data_json` (Phase 2). This is a sidecar for specs.
 *
 * Even sources hostile to EAV endorse it in exactly this shape: the
 * problem is *untyped, unbounded* EAV, not a narrow typed one. And #88
 * is explicit that the alternatives are worse — discrete columns can't
 * express heterogeneous families without a sparse mega-table, and a
 * free-form `[{label,value}]` JSON list can't be faceted or compared at
 * all, which is the entire point.
 *
 * ## Deliberately generic
 *
 * `entity_type` is free text, not an enum. Values can attach to a Phase 2
 * registry entry, a shop variant, or anything else with a stable id —
 * nothing here knows about vacuum pumps, or about any particular client's
 * content model.
 */
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Attribute data types.
 *
 * `measurement` is the one that earns its keep: value + authored unit,
 * normalized to the family's standard unit on write so comparison and
 * faceting run on one canonical number (#88 §C.1).
 */
export const ATTRIBUTE_DATA_TYPES = [
  "number",
  "measurement",
  "select",
  "multiselect",
  "boolean",
  "text",
] as const;

export type AttributeDataType = (typeof ATTRIBUTE_DATA_TYPES)[number];

/**
 * Stand-in for "this value is not per-locale", used instead of NULL in
 * `attribute_values.locale`.
 *
 * SQLite considers NULLs distinct in a UNIQUE index, so a nullable
 * locale would make the (entity, attribute, locale) constraint
 * unenforceable for the common non-localized case. `*` cannot collide
 * with a real locale tag, which are validated against the runtime
 * supported-locale list.
 */
export const NON_LOCALIZED_SENTINEL = "*";

/**
 * Stand-in for "this value carries no context qualifier" (#98), used
 * instead of NULL in `attribute_values.qualifier`.
 *
 * Same rationale as NON_LOCALIZED_SENTINEL: SQLite considers NULLs
 * distinct in a UNIQUE index, so a nullable qualifier would make the
 * (entity, attribute, locale, qualifier) constraint unenforceable for
 * every unqualified value — i.e. the common case.
 */
export const UNQUALIFIED_SENTINEL = "*";

// ─── Definitions (the registry) ─────────────────────────────

export const attributeDefinitions = sqliteTable(
  "attribute_definitions",
  {
    id: text("id").primaryKey(),
    /**
     * Machine key — 'flow_rate', 'ultimate_pressure'. Globally unique so
     * a comparison across families still aligns rows by attribute.
     */
    key: text("key").notNull().unique(),
    dataType: text("data_type", { enum: ATTRIBUTE_DATA_TYPES }).notNull(),
    /**
     * Required when dataType is 'measurement'; null otherwise. Names the
     * unit family ('pressure', 'flow') that values convert within.
     */
    measureFamily: text("measure_family"),
    /**
     * Cached from the family table on write. Denormalized deliberately:
     * rendering a datasheet needs it on every row, and the families are
     * compile-time constants that cannot drift.
     */
    standardUnit: text("standard_unit"),
    /** JSON array of option keys, for select / multiselect. */
    optionsJson: text("options_json"),
    /**
     * Which direction is "better" within this attribute (#98):
     * 'higher' | 'lower' | null when there is no natural ordering.
     *
     * Without it every "best first" sort, top-N widget and
     * winning-cell highlight is BACKWARDS for any lower-is-better
     * attribute — vacuum pressure, sound level, power draw, latency,
     * price, lead time. Null for things like connection size or colour,
     * where "better" is meaningless.
     *
     * Deliberately per-attribute rather than per-measure-family: two
     * pressure attributes can disagree (ultimate pressure lower-is-
     * better, burst pressure higher-is-better).
     */
    betterDirection: text("better_direction", {
      enum: ["higher", "lower"],
    }),
    /**
     * Allowed qualifier vocabulary for this attribute's values (#98), as
     * a JSON array: `["50hz","60hz"]`.
     *
     * Advisory, not a constraint: it tells the admin UI which inputs to
     * render and the compare view which columns align. Null means the
     * attribute takes unqualified values only.
     *
     * The engine never interprets the strings — '50hz' is user data.
     */
    qualifiersJson: text("qualifiers_json"),
    /**
     * Grouping hint for datasheet layout — 'performance', 'electrical',
     * 'mechanical'. Purely presentational; no query depends on it.
     */
    groupKey: text("group_key"),
    /** Display order within a group. */
    position: integer("position").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    dataTypeIdx: index("attribute_definitions_data_type_idx").on(t.dataType),
    groupIdx: index("attribute_definitions_group_idx").on(
      t.groupKey,
      t.position,
    ),
  }),
);

/**
 * Per-locale labels, following the repo's base-row + sibling
 * `_localizations` convention (#88 §C.1 asks for exactly this).
 *
 * `locale` is plain text rather than an enum, matching Phase 2 — the
 * older content tables bake ["th","en"] into ~8 schemas and adding a
 * locale means a migration everywhere.
 */
export const attributeDefinitionLocalizations = sqliteTable(
  "attribute_definition_localizations",
  {
    id: text("id").primaryKey(),
    attributeId: text("attribute_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    label: text("label").notNull(),
    /** Editor-facing help text, e.g. "measured at 50 Hz". */
    description: text("description"),
    /**
     * Per-locale option labels for select/multiselect, as a JSON object
     * keyed by option key: `{"oil_free": "Oil-free"}`. The keys
     * themselves stay locale-independent so stored values never move.
     */
    optionLabelsJson: text("option_labels_json"),
  },
  (t) => ({
    attrLocaleIdx: uniqueIndex(
      "attribute_definition_localizations_attr_locale_idx",
    ).on(t.attributeId, t.locale),
  }),
);

// ─── Families (per-product-type attribute sets) ─────────────

/**
 * A family is a named attribute set — 'vacuum_pump', 'blower'. This is
 * #88's answer to "different product families have different specs":
 * pumps and blowers carry different attributes rather than sharing one
 * sparse wide table full of nulls.
 */
export const attributeFamilies = sqliteTable("attribute_families", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  labelsJson: text("labels_json"),
  description: text("description"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Which attributes a family carries, in what order.
 *
 * Composite PK — an attribute appears at most once per family.
 */
export const familyAttributes = sqliteTable(
  "family_attributes",
  {
    familyId: text("family_id")
      .notNull()
      .references(() => attributeFamilies.id, { onDelete: "cascade" }),
    attributeId: text("attribute_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Marks this attribute as a variant axis — the dimension that
     * distinguishes siblings (#88 §B.2). Akeneo's rule, which this
     * enforces at write time: an axis must be structured
     * (select/measurement/boolean), never free text, or the variants
     * can't be reliably grouped.
     */
    isVariantAxis: integer("is_variant_axis", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.familyId, t.attributeId] }),
    familyOrderIdx: index("family_attributes_family_order_idx").on(
      t.familyId,
      t.sortOrder,
    ),
    // Reverse lookup: "which families use this attribute?" — needed
    // before allowing a definition to be deleted.
    attributeIdx: index("family_attributes_attribute_idx").on(t.attributeId),
  }),
);

/**
 * Binds an entity to a family, so the entity knows which attribute set
 * it carries.
 *
 * Separate from the entity's own table because entities live in several
 * places (Phase 2 `entries`, shop variants, …) and none of them should
 * grow a column for this.
 */
export const entityFamilies = sqliteTable(
  "entity_families",
  {
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    familyId: text("family_id")
      .notNull()
      .references(() => attributeFamilies.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    // One family per entity. A second would make "which attributes does
    // this carry?" ambiguous.
    pk: primaryKey({ columns: [t.entityType, t.entityId] }),
    familyIdx: index("entity_families_family_idx").on(t.familyId),
  }),
);

// ─── Values (normalized, queryable) ─────────────────────────

/**
 * The values table (#88 §C.3).
 *
 * Split by type so comparisons stay typed — the single most important
 * property here. `value_number` always holds the STANDARD-unit magnitude
 * for measurements, with `value_unit` preserving what the editor actually
 * typed, so:
 *
 *   - facet/sort: `WHERE attribute_id=? AND value_number BETWEEN ? AND ?`
 *     is correct across mixed authored units
 *   - display: the datasheet still renders "0.1 mbar", not "10 Pa"
 */
export const attributeValues = sqliteTable(
  "attribute_values",
  {
    id: text("id").primaryKey(),
    /** e.g. 'entry' (Phase 2), 'shop_variant'. Free text by design. */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    attributeId: text("attribute_id")
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: "cascade" }),
    /**
     * Locale for `text` attributes that genuinely differ per language.
     *
     * Non-localized attributes (the common case — a flow rate is the same
     * number in every language) use the sentinel `NON_LOCALIZED_SENTINEL`
     * rather than NULL, and the column is NOT NULL to enforce it.
     *
     * This is not cosmetic. SQLite treats NULLs as distinct in a UNIQUE
     * index, so with a nullable locale the uniqueness constraint below
     * silently does not apply to non-localized values — two rows for the
     * same (entity, attribute) both pass. A datasheet then renders the
     * attribute twice and `compare()` picks whichever row it finds first.
     * Verified: inserting a second row with locale=NULL was accepted.
     */
    locale: text("locale").notNull().default(NON_LOCALIZED_SENTINEL),
    /**
     * Context discriminator (#98) — e.g. '50hz', '60hz', '230v'.
     *
     * One attribute can hold several context-keyed values instead of
     * forcing prose ("80 m³/h (50 Hz), 98 m³/h (60 Hz)") or two
     * near-duplicate definitions that no compare view can align into a
     * single row.
     *
     * NOT NULL with an `UNQUALIFIED_SENTINEL` default, for the same
     * reason as `locale` above: a nullable discriminator inside a UNIQUE
     * index is inert in SQLite, so the uniqueness constraint would stop
     * applying to the common unqualified case.
     *
     * The vocabulary is deliberately NOT constrained here. '50hz' is
     * user data; the engine only needs the values to be comparable.
     */
    qualifier: text("qualifier").notNull().default(UNQUALIFIED_SENTINEL),
    /**
     * Numeric value as a CLOSED INTERVAL in the standard unit (#98).
     *
     * A scalar sets both bounds equal. Half of a real catalog's specs are
     * genuinely intervals — tolerance bands, "22-25 kg depending on
     * motor", performance ranges — and a single magnitude column forces
     * those into prose in `value_text`, which is precisely the
     * free-form-string trap the typed spec layer exists to avoid.
     *
     * Faceting becomes an interval-overlap test, which is also *more*
     * correct than a point test for genuine ranges:
     *
     *   WHERE value_number_max >= :lo AND value_number_min <= :hi
     *
     * `real`, not integer: pressures like 1e-3 mbar and flows like
     * 0.06 m³/h need fractions.
     */
    valueNumberMin: real("value_number_min"),
    valueNumberMax: real("value_number_max"),
    /** Unit as authored ('mbar', 'm3/h'), for faithful display. */
    valueUnit: text("value_unit"),
    /** Text value, or a select option key. */
    valueText: text("value_text"),
    /** JSON array of option keys, for multiselect. */
    valueJson: text("value_json"),
    valueBool: integer("value_bool", { mode: "boolean" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    // One value per (entity, attribute, locale). Without this a second
    // write would silently duplicate rather than update, and a datasheet
    // would render the attribute twice.
    // One value per (entity, attribute, locale, qualifier). The
    // qualifier is part of the key since #98 — without it, a 50 Hz and a
    // 60 Hz value for one attribute would collide and the second write
    // would overwrite the first instead of sitting alongside it.
    entityAttrIdx: uniqueIndex("attribute_values_entity_attr_idx").on(
      t.entityType,
      t.entityId,
      t.attributeId,
      t.locale,
      t.qualifier,
    ),
    // Datasheet assembly: every value for one entity (#88 §C.3).
    entityIdx: index("attribute_values_entity_idx").on(
      t.entityType,
      t.entityId,
    ),
    // Faceting and sorting on a numeric attribute — the index that makes
    // "pumping speed 100–300 m³/h" an index seek rather than a scan.
    numericFacetIdx: index("attribute_values_numeric_facet_idx").on(
      t.attributeId,
      t.valueNumberMin,
      t.valueNumberMax,
    ),
    // Faceting on a select option key.
    textFacetIdx: index("attribute_values_text_facet_idx").on(
      t.attributeId,
      t.valueText,
    ),
  }),
);

// ─── Type exports ───────────────────────────────────────────

export type AttributeDefinition = typeof attributeDefinitions.$inferSelect;
export type AttributeDefinitionLocalization =
  typeof attributeDefinitionLocalizations.$inferSelect;
export type AttributeFamily = typeof attributeFamilies.$inferSelect;
export type FamilyAttribute = typeof familyAttributes.$inferSelect;
export type EntityFamily = typeof entityFamilies.$inferSelect;
export type AttributeValue = typeof attributeValues.$inferSelect;
