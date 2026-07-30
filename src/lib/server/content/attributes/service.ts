/**
 * Attribute service — Phase 3 (#88).
 *
 * Write side: define attributes, assemble families, set values with
 * unit normalization and type validation.
 *
 * Read side: the three capabilities #88 says rich text cannot provide —
 *
 *   datasheet(entity)          one entity's specs, grouped, display-ready
 *   compare(entities)          rows × attributes, pivoted for a table
 *   facet(attribute, range)    entity ids matching a typed predicate
 *
 * All three are batched: one query per entity *set*, never per entity,
 * so they don't reintroduce the N+1 that Phase 1 removed.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  attributeDefinitionLocalizations,
  attributeDefinitions,
  attributeFamilies,
  attributeValues,
  entityFamilies,
  familyAttributes,
  ATTRIBUTE_DATA_TYPES,
  NON_LOCALIZED_SENTINEL,
  UNQUALIFIED_SENTINEL,
  type AttributeDataType,
  type AttributeDefinition,
} from "./schema";
import {
  FAMILIES,
  isMeasureFamily,
  normalize,
  UnitError,
  type MeasureFamily,
} from "./units";

/** D1 binds at most 100 parameters per statement. */
const D1_MAX_BIND_PARAMS = 100;

/** Machine keys double as JSON keys and API params. */
const KEY_PATTERN = /^[a-z](?:_?[a-z0-9])*$/;
const KEY_MAX_LENGTH = 63;

export class AttributeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_KEY"
      | "DUPLICATE_KEY"
      | "UNKNOWN_ATTRIBUTE"
      | "UNKNOWN_FAMILY"
      | "INVALID_DATA_TYPE"
      | "INVALID_CONFIG"
      | "INVALID_VALUE"
      | "MISSING_UNIT"
      | "UNKNOWN_UNIT"
      | "REQUIRED_MISSING"
      | "INVALID_VARIANT_AXIS"
      | "IN_USE",
  ) {
    super(message);
    this.name = "AttributeError";
  }
}

function assertValidKey(key: string, what: string): void {
  if (!KEY_PATTERN.test(key) || key.length > KEY_MAX_LENGTH) {
    throw new AttributeError(
      `Invalid ${what} "${key}" — lowercase letters, digits and single underscores only, max ${KEY_MAX_LENGTH} chars`,
      "INVALID_KEY",
    );
  }
}

/** A resolved value, ready to render. */
export interface ResolvedValue {
  attributeKey: string;
  attributeId: string;
  dataType: AttributeDataType;
  label: string;
  groupKey: string | null;
  position: number;
  /**
   * Standard-unit LOWER bound, for sorting/comparing. Null for
   * non-numeric. Equals `standardValueMax` for a scalar.
   */
  standardValue: number | null;
  /** Standard-unit UPPER bound (#98). Equals `standardValue` for a scalar. */
  standardValueMax: number | null;
  /**
   * Context discriminator (#98) — '50hz', '230v' — or null when the value
   * is unqualified. The compare view aligns rows by (attribute, qualifier).
   */
  qualifier: string | null;
  /** Value in the unit it was authored in — what a datasheet shows. */
  displayValue: string | number | boolean | string[] | null;
  /** Authored unit, e.g. 'mbar'. Null for non-measurements. */
  unit: string | null;
  measureFamily: string | null;
}

export interface DatasheetGroup {
  groupKey: string | null;
  rows: ResolvedValue[];
}

export interface CreateAttributeInput {
  key: string;
  dataType: AttributeDataType;
  /** Required when dataType is 'measurement'. */
  measureFamily?: string;
  /** Required for select / multiselect. */
  options?: string[];
  groupKey?: string;
  position?: number;
  labels?: Record<string, { label: string; description?: string }>;
  createdBy?: string;
}

/**
 * A value as supplied by a caller, before normalization.
 *
 * `max` (#98) makes a numeric value an INTERVAL rather than a point.
 * Omit it for a scalar — both bounds are then set equal, so every query
 * is an overlap test regardless of which shape was authored.
 */
export type RawValueInput =
  | { kind: "number"; value: number; max?: number }
  | { kind: "measurement"; value: number; unit: string; max?: number }
  | { kind: "select"; option: string }
  | { kind: "multiselect"; options: string[] }
  | { kind: "boolean"; value: boolean }
  | { kind: "text"; value: string; locale?: string };

export class AttributeService {
  private db: ReturnType<typeof drizzle>;

  constructor(
    private readonly d1: D1Database,
    private readonly opts: {
      supportedLocales: readonly string[];
      defaultLocale: string;
    },
  ) {
    this.db = drizzle(d1);
  }

  private now() {
    return new Date().toISOString();
  }

  // ─── Definitions ──────────────────────────────────────────

  async createAttribute(
    input: CreateAttributeInput,
  ): Promise<AttributeDefinition> {
    assertValidKey(input.key, "attribute key");

    if (!ATTRIBUTE_DATA_TYPES.includes(input.dataType)) {
      throw new AttributeError(
        `Unknown data type "${input.dataType}"`,
        "INVALID_DATA_TYPE",
      );
    }

    // A measurement without a family has no canonical unit, so its
    // values could never be compared — which is the only reason the type
    // exists. Reject at definition time rather than on first write.
    let measureFamily: MeasureFamily | null = null;
    let standardUnit: string | null = null;
    if (input.dataType === "measurement") {
      if (!input.measureFamily) {
        throw new AttributeError(
          `Attribute "${input.key}" is a measurement and requires measureFamily (one of: ${Object.keys(FAMILIES).join(", ")})`,
          "INVALID_CONFIG",
        );
      }
      if (!isMeasureFamily(input.measureFamily)) {
        throw new AttributeError(
          `Unknown measure family "${input.measureFamily}"`,
          "UNKNOWN_FAMILY",
        );
      }
      measureFamily = input.measureFamily;
      standardUnit = FAMILIES[measureFamily].standardUnit;
    } else if (input.measureFamily) {
      throw new AttributeError(
        `measureFamily is only valid for measurement attributes, not "${input.dataType}"`,
        "INVALID_CONFIG",
      );
    }

    const needsOptions =
      input.dataType === "select" || input.dataType === "multiselect";
    if (needsOptions) {
      if (!input.options?.length) {
        throw new AttributeError(
          `Attribute "${input.key}" is a ${input.dataType} and requires a non-empty options array`,
          "INVALID_CONFIG",
        );
      }
      const seen = new Set(input.options);
      if (seen.size !== input.options.length) {
        throw new AttributeError(
          `Attribute "${input.key}" has duplicate options`,
          "INVALID_CONFIG",
        );
      }
      for (const option of input.options) assertValidKey(option, "option key");
    } else if (input.options?.length) {
      throw new AttributeError(
        `options is only valid for select/multiselect, not "${input.dataType}"`,
        "INVALID_CONFIG",
      );
    }

    const existing = await this.db
      .select({ id: attributeDefinitions.id })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.key, input.key))
      .limit(1)
      .get();
    if (existing) {
      throw new AttributeError(
        `An attribute with key "${input.key}" already exists`,
        "DUPLICATE_KEY",
      );
    }

    const id = nanoid();
    const now = this.now();
    await this.db.insert(attributeDefinitions).values({
      id,
      key: input.key,
      dataType: input.dataType,
      measureFamily,
      standardUnit,
      optionsJson: needsOptions ? JSON.stringify(input.options) : null,
      groupKey: input.groupKey ?? null,
      position: input.position ?? 0,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });

    for (const [locale, l] of Object.entries(input.labels ?? {})) {
      if (!this.opts.supportedLocales.includes(locale)) continue;
      await this.db.insert(attributeDefinitionLocalizations).values({
        id: nanoid(),
        attributeId: id,
        locale,
        label: l.label,
        description: l.description ?? null,
        optionLabelsJson: null,
      });
    }

    return (await this.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, id))
      .get())!;
  }

  async listAttributes(): Promise<AttributeDefinition[]> {
    return this.db
      .select()
      .from(attributeDefinitions)
      .orderBy(
        asc(attributeDefinitions.position),
        asc(attributeDefinitions.key),
      )
      .all();
  }

  async getAttributeByKey(key: string): Promise<AttributeDefinition | null> {
    return (
      (await this.db
        .select()
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.key, key))
        .limit(1)
        .get()) ?? null
    );
  }

  /**
   * Delete a definition. Refuses while any family still declares it —
   * cascading would silently strip the attribute from every product that
   * carries it.
   */
  async deleteAttribute(key: string): Promise<void> {
    const attr = await this.getAttributeByKey(key);
    if (!attr) {
      throw new AttributeError(
        `Unknown attribute "${key}"`,
        "UNKNOWN_ATTRIBUTE",
      );
    }
    const uses = await this.db
      .select({ familyId: familyAttributes.familyId })
      .from(familyAttributes)
      .where(eq(familyAttributes.attributeId, attr.id))
      .all();
    if (uses.length > 0) {
      throw new AttributeError(
        `Cannot delete "${key}" — still declared by ${uses.length} family/families. Remove it from them first.`,
        "IN_USE",
      );
    }
    await this.db
      .delete(attributeDefinitions)
      .where(eq(attributeDefinitions.id, attr.id));
  }

  // ─── Families ─────────────────────────────────────────────

  async createFamily(input: {
    key: string;
    labels?: Record<string, string>;
    description?: string;
    createdBy?: string;
  }) {
    assertValidKey(input.key, "family key");
    const existing = await this.db
      .select({ id: attributeFamilies.id })
      .from(attributeFamilies)
      .where(eq(attributeFamilies.key, input.key))
      .limit(1)
      .get();
    if (existing) {
      throw new AttributeError(
        `A family with key "${input.key}" already exists`,
        "DUPLICATE_KEY",
      );
    }
    const id = nanoid();
    const now = this.now();
    await this.db.insert(attributeFamilies).values({
      id,
      key: input.key,
      labelsJson: input.labels ? JSON.stringify(input.labels) : null,
      description: input.description ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return (await this.db
      .select()
      .from(attributeFamilies)
      .where(eq(attributeFamilies.id, id))
      .get())!;
  }

  /**
   * Add an attribute to a family.
   *
   * Enforces Akeneo's variant-axis rule: an axis must be structured
   * (select / measurement / boolean). A free-text axis can't reliably
   * group siblings — "1.5kW" and "1.5 kW" would be different variants.
   */
  async addAttributeToFamily(
    familyKey: string,
    attributeKey: string,
    opts: {
      required?: boolean;
      sortOrder?: number;
      isVariantAxis?: boolean;
    } = {},
  ): Promise<void> {
    const family = await this.requireFamily(familyKey);
    const attr = await this.getAttributeByKey(attributeKey);
    if (!attr) {
      throw new AttributeError(
        `Unknown attribute "${attributeKey}"`,
        "UNKNOWN_ATTRIBUTE",
      );
    }

    if (opts.isVariantAxis) {
      const structured: AttributeDataType[] = [
        "select",
        "measurement",
        "boolean",
      ];
      if (!structured.includes(attr.dataType)) {
        throw new AttributeError(
          `"${attributeKey}" is a ${attr.dataType} and cannot be a variant axis — axes must be select, measurement or boolean so siblings group reliably`,
          "INVALID_VARIANT_AXIS",
        );
      }
    }

    await this.db
      .insert(familyAttributes)
      .values({
        familyId: family.id,
        attributeId: attr.id,
        required: opts.required ?? false,
        sortOrder: opts.sortOrder ?? 0,
        isVariantAxis: opts.isVariantAxis ?? false,
        createdAt: this.now(),
      })
      .onConflictDoNothing();
  }

  /** Bind an entity to a family. Replaces any existing binding. */
  async assignFamily(
    entityType: string,
    entityId: string,
    familyKey: string,
  ): Promise<void> {
    const family = await this.requireFamily(familyKey);
    await this.db
      .delete(entityFamilies)
      .where(
        and(
          eq(entityFamilies.entityType, entityType),
          eq(entityFamilies.entityId, entityId),
        ),
      );
    await this.db.insert(entityFamilies).values({
      entityType,
      entityId,
      familyId: family.id,
      createdAt: this.now(),
    });
  }

  /** Attributes a family declares, in display order. */
  async familyAttributeList(familyKey: string) {
    const family = await this.requireFamily(familyKey);
    return this.db
      .select({
        attribute: attributeDefinitions,
        required: familyAttributes.required,
        sortOrder: familyAttributes.sortOrder,
        isVariantAxis: familyAttributes.isVariantAxis,
      })
      .from(familyAttributes)
      .innerJoin(
        attributeDefinitions,
        eq(attributeDefinitions.id, familyAttributes.attributeId),
      )
      .where(eq(familyAttributes.familyId, family.id))
      .orderBy(asc(familyAttributes.sortOrder), asc(attributeDefinitions.key))
      .all();
  }

  private async requireFamily(key: string) {
    const family = await this.db
      .select()
      .from(attributeFamilies)
      .where(eq(attributeFamilies.key, key))
      .limit(1)
      .get();
    if (!family) {
      throw new AttributeError(
        `Unknown attribute family "${key}"`,
        "UNKNOWN_FAMILY",
      );
    }
    return family;
  }

  // ─── Values ───────────────────────────────────────────────

  /**
   * Set one attribute value, normalizing measurements on the way in.
   *
   * Upsert on (entityType, entityId, attributeId, locale) — the unique
   * index makes a repeated write an update rather than a duplicate row.
   */
  /**
   * Write one value.
   *
   * `qualifier` (#98) lets one attribute hold several context-keyed
   * values — a 50 Hz and a 60 Hz speed sit alongside each other rather
   * than the second overwriting the first, because the qualifier is part
   * of the uniqueness key.
   */
  async setValue(
    entityType: string,
    entityId: string,
    attributeKey: string,
    input: RawValueInput,
    /** Context key (#98) — '50hz'. Omit for an unqualified value. */
    qualifier?: string,
  ): Promise<void> {
    const attr = await this.getAttributeByKey(attributeKey);
    if (!attr) {
      throw new AttributeError(
        `Unknown attribute "${attributeKey}"`,
        "UNKNOWN_ATTRIBUTE",
      );
    }
    if (input.kind !== attr.dataType) {
      throw new AttributeError(
        `Attribute "${attributeKey}" is a ${attr.dataType}, but a ${input.kind} value was supplied`,
        "INVALID_VALUE",
      );
    }

    const row = this.buildValueRow(attr, input);
    // Never NULL — see NON_LOCALIZED_SENTINEL. A NULL here would make the
    // (entity, attribute, locale) unique index inert in SQLite.
    const locale = row.locale ?? NON_LOCALIZED_SENTINEL;
    // Never NULL, for the same reason as locale — see
    // UNQUALIFIED_SENTINEL.
    const qual = qualifier ?? UNQUALIFIED_SENTINEL;
    const now = this.now();

    const existing = await this.db
      .select({ id: attributeValues.id })
      .from(attributeValues)
      .where(
        and(
          eq(attributeValues.entityType, entityType),
          eq(attributeValues.entityId, entityId),
          eq(attributeValues.attributeId, attr.id),
          eq(attributeValues.locale, locale),
          eq(attributeValues.qualifier, qual),
        ),
      )
      .limit(1)
      .get();

    if (existing) {
      await this.db
        .update(attributeValues)
        .set({ ...row, locale, qualifier: qual, updatedAt: now })
        .where(eq(attributeValues.id, existing.id));
      return;
    }

    await this.db.insert(attributeValues).values({
      id: nanoid(),
      entityType,
      entityId,
      attributeId: attr.id,
      ...row,
      locale,
      qualifier: qual,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Translate a typed input into the table's columns.
   *
   * For a measurement this is where unit normalization happens: the
   * canonical interval goes to `valueNumberMin`/`Max` and the unit is
   * preserved in `valueUnit`, so faceting is correct and display is
   * faithful.
   */
  private buildValueRow(attr: AttributeDefinition, input: RawValueInput) {
    const base = {
      locale: null as string | null,
      valueNumberMin: null as number | null,
      valueNumberMax: null as number | null,
      valueUnit: null as string | null,
      valueText: null as string | null,
      valueJson: null as string | null,
      valueBool: null as boolean | null,
    };

    switch (input.kind) {
      case "number": {
        if (!Number.isFinite(input.value)) {
          throw new AttributeError(
            `Attribute "${attr.key}" requires a finite number`,
            "INVALID_VALUE",
          );
        }
        const max = input.max ?? input.value;
        if (!Number.isFinite(max)) {
          throw new AttributeError(
            `Attribute "${attr.key}" range max must be a finite number`,
            "INVALID_VALUE",
          );
        }
        if (max < input.value) {
          throw new AttributeError(
            `Attribute "${attr.key}" range is inverted (${input.value} > ${max})`,
            "INVALID_VALUE",
          );
        }
        // A scalar sets both bounds equal, so every read path is a single
        // overlap test and never has to branch on "is this a range?".
        return { ...base, valueNumberMin: input.value, valueNumberMax: max };
      }

      case "measurement": {
        if (!attr.measureFamily || !isMeasureFamily(attr.measureFamily)) {
          throw new AttributeError(
            `Attribute "${attr.key}" has no valid measure family`,
            "INVALID_CONFIG",
          );
        }
        if (!input.unit) {
          throw new AttributeError(
            `Attribute "${attr.key}" is a measurement and requires a unit`,
            "MISSING_UNIT",
          );
        }
        try {
          const lo = normalize(attr.measureFamily, input.value, input.unit);
          // Both bounds normalize through the SAME family+unit, so a
          // range authored in m3/min compares correctly against one
          // authored in m3/h.
          const hi =
            input.max === undefined
              ? lo
              : normalize(attr.measureFamily, input.max, input.unit);
          if (hi.standardValue < lo.standardValue) {
            throw new AttributeError(
              `Attribute "${attr.key}" range is inverted (${input.value} > ${input.max} ${input.unit})`,
              "INVALID_VALUE",
            );
          }
          return {
            ...base,
            // Canonical interval — what every query compares on.
            valueNumberMin: lo.standardValue,
            valueNumberMax: hi.standardValue,
            // Authored unit — what the datasheet renders.
            valueUnit: lo.unit,
          };
        } catch (err) {
          if (err instanceof UnitError) {
            throw new AttributeError(
              err.message,
              err.code === "UNKNOWN_UNIT" ? "UNKNOWN_UNIT" : "INVALID_VALUE",
            );
          }
          throw err;
        }
      }

      case "select": {
        const options = this.optionsOf(attr);
        if (!options.includes(input.option)) {
          throw new AttributeError(
            `"${input.option}" is not an option of "${attr.key}" (${options.join(", ")})`,
            "INVALID_VALUE",
          );
        }
        return { ...base, valueText: input.option };
      }

      case "multiselect": {
        const options = this.optionsOf(attr);
        const unique = Array.from(new Set(input.options));
        for (const o of unique) {
          if (!options.includes(o)) {
            throw new AttributeError(
              `"${o}" is not an option of "${attr.key}" (${options.join(", ")})`,
              "INVALID_VALUE",
            );
          }
        }
        return { ...base, valueJson: JSON.stringify(unique) };
      }

      case "boolean":
        return { ...base, valueBool: input.value };

      case "text": {
        if (
          input.locale &&
          !this.opts.supportedLocales.includes(input.locale)
        ) {
          throw new AttributeError(
            `Unsupported locale "${input.locale}"`,
            "INVALID_VALUE",
          );
        }
        return {
          ...base,
          locale: input.locale ?? null,
          valueText: input.value,
        };
      }
    }
  }

  private optionsOf(attr: AttributeDefinition): string[] {
    if (!attr.optionsJson) return [];
    try {
      const parsed = JSON.parse(attr.optionsJson);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }

  // ─── Read: datasheet / compare / facet ────────────────────

  /**
   * One entity's specs, grouped for rendering (#88 §C.3).
   *
   * Two queries total regardless of attribute count: values joined to
   * their definitions, plus labels for the requested locale.
   */
  async datasheet(
    entityType: string,
    entityId: string,
    locale?: string,
  ): Promise<DatasheetGroup[]> {
    const resolved = await this.resolveValues(entityType, [entityId], locale);
    const rows = resolved.get(entityId) ?? [];

    const byGroup = new Map<string | null, ResolvedValue[]>();
    for (const row of rows) {
      const list = byGroup.get(row.groupKey) ?? [];
      list.push(row);
      byGroup.set(row.groupKey, list);
    }

    return (
      Array.from(byGroup.entries())
        .map(([groupKey, groupRows]) => ({
          groupKey,
          rows: groupRows.sort(
            (a, b) =>
              a.position - b.position ||
              a.attributeKey.localeCompare(b.attributeKey),
          ),
        }))
        // Ungrouped rows last — a named group is more specific than none.
        .sort((a, b) => {
          if (a.groupKey === null) return 1;
          if (b.groupKey === null) return -1;
          return a.groupKey.localeCompare(b.groupKey);
        })
    );
  }

  /**
   * Comparison table: N entities × their union of attributes (#88 §C.3).
   *
   * Returns rows keyed by attribute so a template can render one table
   * row per spec with one column per entity — the shape rich text cannot
   * produce. Attributes absent on an entity come back as null rather
   * than being omitted, so columns stay aligned.
   */
  async compare(
    entityType: string,
    entityIds: string[],
    locale?: string,
  ): Promise<{
    entityIds: string[];
    rows: {
      attributeKey: string;
      label: string;
      groupKey: string | null;
      unit: string | null;
      /** Indexed in step with `entityIds`. */
      values: (ResolvedValue | null)[];
    }[];
  }> {
    const resolved = await this.resolveValues(entityType, entityIds, locale);

    // Union of attributes across all entities, keeping definition order.
    const attrOrder = new Map<
      string,
      {
        label: string;
        groupKey: string | null;
        position: number;
        unit: string | null;
      }
    >();
    for (const rows of resolved.values()) {
      for (const r of rows) {
        if (!attrOrder.has(r.attributeKey)) {
          attrOrder.set(r.attributeKey, {
            label: r.label,
            groupKey: r.groupKey,
            position: r.position,
            unit: r.unit,
          });
        }
      }
    }

    const rows = Array.from(attrOrder.entries())
      .sort(
        ([ka, a], [kb, b]) => a.position - b.position || ka.localeCompare(kb),
      )
      .map(([attributeKey, meta]) => ({
        attributeKey,
        label: meta.label,
        groupKey: meta.groupKey,
        unit: meta.unit,
        values: entityIds.map(
          (id) =>
            resolved.get(id)?.find((r) => r.attributeKey === attributeKey) ??
            null,
        ),
      }));

    return { entityIds, rows };
  }

  /**
   * Faceted filter / sort on one attribute (#88 §C.3).
   *
   * Because both bounds are always standard-unit magnitudes, a range
   * expressed in ANY unit of the family is correct — the bounds are
   * normalized here before comparison, so "100–300 m³/h" and
   * "1.67–5 m³/min" select the same entities.
   */
  async facet(
    attributeKey: string,
    filter:
      | { kind: "range"; min?: number; max?: number; unit?: string }
      | { kind: "option"; options: string[] }
      | { kind: "boolean"; value: boolean },
    opts: { entityType?: string; limit?: number; sort?: "asc" | "desc" } = {},
  ): Promise<
    {
      entityType: string;
      entityId: string;
      value: number | string | boolean | null;
    }[]
  > {
    const attr = await this.getAttributeByKey(attributeKey);
    if (!attr) {
      throw new AttributeError(
        `Unknown attribute "${attributeKey}"`,
        "UNKNOWN_ATTRIBUTE",
      );
    }

    const conditions = [eq(attributeValues.attributeId, attr.id)];
    if (opts.entityType) {
      conditions.push(eq(attributeValues.entityType, opts.entityType));
    }

    if (filter.kind === "range") {
      if (attr.dataType !== "number" && attr.dataType !== "measurement") {
        throw new AttributeError(
          `Attribute "${attributeKey}" is a ${attr.dataType} and cannot be range-filtered`,
          "INVALID_VALUE",
        );
      }
      // Normalize the bounds into the standard unit so a caller can
      // express the range in whatever unit they think in.
      //
      // A measurement REQUIRES an explicit unit. Silently treating a bare
      // bound as already-canonical is a wrong-results bug, not a
      // convenience: `min=0.1` on a pressure attribute almost certainly
      // means 0.1 mbar, but stored values are pascals, so it would match
      // nothing and report "no results" rather than an error. Demanding
      // the unit makes the caller's intent explicit.
      const isMeasurement =
        attr.dataType === "measurement" &&
        !!attr.measureFamily &&
        isMeasureFamily(attr.measureFamily);

      if (isMeasurement && !filter.unit) {
        throw new AttributeError(
          `Attribute "${attributeKey}" is a measurement (${attr.measureFamily}); a range filter must specify the unit its bounds are in`,
          "MISSING_UNIT",
        );
      }
      if (!isMeasurement && filter.unit) {
        throw new AttributeError(
          `Attribute "${attributeKey}" is a plain ${attr.dataType} and has no units — drop the unit parameter`,
          "INVALID_VALUE",
        );
      }

      const toStandard = (v: number): number =>
        isMeasurement
          ? normalize(
              attr.measureFamily as MeasureFamily,
              v,
              filter.unit as string,
            ).standardValue
          : v;
      // Interval OVERLAP, not a point test (#98): a value whose range is
      // 150-170 must match a 100-160 filter. Note the operands are
      // deliberately crossed — a stored interval overlaps the requested
      // one when its max is at least the requested min AND its min is at
      // most the requested max.
      if (filter.min !== undefined) {
        conditions.push(
          gte(attributeValues.valueNumberMax, toStandard(filter.min)),
        );
      }
      if (filter.max !== undefined) {
        conditions.push(
          lte(attributeValues.valueNumberMin, toStandard(filter.max)),
        );
      }
    } else if (filter.kind === "option") {
      if (filter.options.length === 0) return [];
      conditions.push(inArray(attributeValues.valueText, filter.options));
    } else {
      conditions.push(eq(attributeValues.valueBool, filter.value));
    }

    const order =
      filter.kind === "range"
        ? opts.sort === "desc"
          ? sql`${attributeValues.valueNumberMin} DESC`
          : sql`${attributeValues.valueNumberMin} ASC`
        : sql`${attributeValues.valueText} ASC`;

    const rows = await this.db
      .select({
        entityType: attributeValues.entityType,
        entityId: attributeValues.entityId,
        valueNumberMin: attributeValues.valueNumberMin,
        valueNumberMax: attributeValues.valueNumberMax,
        qualifier: attributeValues.qualifier,
        valueText: attributeValues.valueText,
        valueBool: attributeValues.valueBool,
      })
      .from(attributeValues)
      .where(and(...conditions))
      .orderBy(order)
      .limit(Math.min(500, Math.max(1, opts.limit ?? 100)))
      .all();

    return rows.map((r) => ({
      entityType: r.entityType,
      entityId: r.entityId,
      value: r.valueNumberMin ?? r.valueText ?? r.valueBool ?? null,
    }));
  }

  /**
   * Load and resolve values for a set of entities.
   *
   * Batched: one values+definitions query and one labels query for the
   * whole set, chunked to respect D1's bound-parameter ceiling. This is
   * the shared engine behind datasheet() and compare().
   */
  private async resolveValues(
    entityType: string,
    entityIds: string[],
    locale?: string,
  ): Promise<Map<string, ResolvedValue[]>> {
    const out = new Map<string, ResolvedValue[]>();
    if (entityIds.length === 0) return out;

    const wanted = locale ?? this.opts.defaultLocale;

    const rows = await this.loadChunked(entityIds, (chunk) =>
      this.db
        .select({
          entityId: attributeValues.entityId,
          attributeId: attributeValues.attributeId,
          valueNumberMin: attributeValues.valueNumberMin,
          valueNumberMax: attributeValues.valueNumberMax,
          qualifier: attributeValues.qualifier,
          valueUnit: attributeValues.valueUnit,
          valueText: attributeValues.valueText,
          valueJson: attributeValues.valueJson,
          valueBool: attributeValues.valueBool,
          key: attributeDefinitions.key,
          dataType: attributeDefinitions.dataType,
          measureFamily: attributeDefinitions.measureFamily,
          groupKey: attributeDefinitions.groupKey,
          position: attributeDefinitions.position,
        })
        .from(attributeValues)
        .innerJoin(
          attributeDefinitions,
          eq(attributeDefinitions.id, attributeValues.attributeId),
        )
        .where(
          and(
            eq(attributeValues.entityType, entityType),
            inArray(attributeValues.entityId, chunk),
          ),
        )
        .all(),
    );
    if (rows.length === 0) return out;

    // Labels for the requested locale, one query for every attribute
    // seen. Falls back to the machine key when a translation is missing,
    // which is more useful than an empty cell.
    const attrIds = Array.from(new Set(rows.map((r) => r.attributeId)));
    const labels = await this.loadChunked(attrIds, (chunk) =>
      this.db
        .select({
          attributeId: attributeDefinitionLocalizations.attributeId,
          label: attributeDefinitionLocalizations.label,
        })
        .from(attributeDefinitionLocalizations)
        .where(
          and(
            inArray(attributeDefinitionLocalizations.attributeId, chunk),
            eq(attributeDefinitionLocalizations.locale, wanted),
          ),
        )
        .all(),
    );
    const labelByAttr = new Map(labels.map((l) => [l.attributeId, l.label]));

    for (const r of rows) {
      const resolved: ResolvedValue = {
        attributeKey: r.key,
        attributeId: r.attributeId,
        dataType: r.dataType,
        label: labelByAttr.get(r.attributeId) ?? r.key,
        groupKey: r.groupKey,
        position: r.position,
        standardValue: r.valueNumberMin,
        standardValueMax: r.valueNumberMax,
        qualifier: r.qualifier === "*" ? null : r.qualifier,
        unit: r.valueUnit,
        measureFamily: r.measureFamily,
        displayValue: this.displayValueOf(r),
      };
      const list = out.get(r.entityId) ?? [];
      list.push(resolved);
      out.set(r.entityId, list);
    }
    return out;
  }

  /**
   * Reconstruct what the editor authored.
   *
   * For a measurement the stored number is in the STANDARD unit, so it
   * must be converted back into `valueUnit` — otherwise a datasheet
   * would print "10 Pa" where the editor wrote "0.1 mbar".
   */
  private displayValueOf(r: {
    dataType: AttributeDataType;
    valueNumberMin: number | null;
    valueNumberMax: number | null;
    valueUnit: string | null;
    valueText: string | null;
    valueJson: string | null;
    valueBool: boolean | null;
    measureFamily: string | null;
  }): ResolvedValue["displayValue"] {
    switch (r.dataType) {
      case "number":
        return r.valueNumberMin;
      case "measurement": {
        if (
          r.valueNumberMin === null ||
          !r.valueUnit ||
          !r.measureFamily ||
          !isMeasureFamily(r.measureFamily)
        ) {
          return r.valueNumberMin;
        }
        const factor = FAMILIES[r.measureFamily].units[r.valueUnit]?.factor;
        if (!factor) return r.valueNumberMin;
        const authored = r.valueNumberMin / factor;
        // Trim float noise from the round-trip (0.1 mbar → 10 Pa → 0.1)
        // without truncating genuinely small vacuum values like 1e-6.
        return Number(authored.toPrecision(12));
      }
      case "select":
      case "text":
        return r.valueText;
      case "multiselect": {
        if (!r.valueJson) return [];
        try {
          const parsed = JSON.parse(r.valueJson);
          return Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          return [];
        }
      }
      case "boolean":
        return r.valueBool;
    }
  }

  private async loadChunked<T>(
    ids: string[],
    load: (chunk: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    if (ids.length <= D1_MAX_BIND_PARAMS) return load(ids);
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += D1_MAX_BIND_PARAMS) {
      out.push(...(await load(ids.slice(i, i + D1_MAX_BIND_PARAMS))));
    }
    return out;
  }
}
