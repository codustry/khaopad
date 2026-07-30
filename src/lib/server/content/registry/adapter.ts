/**
 * Registry → query-engine adapter — Phase 2.
 *
 * Turns `collections` / `collection_fields` rows into the same
 * `CollectionDef` shape Phase 1's engine already consumes for the
 * built-in tables. This is the join between the two phases, and the
 * reason Phase 1 was worth shipping first: the engine gains
 * user-definable content types without a single change to how it
 * resolves, batches, or caches.
 *
 * Every registry collection reads from the shared `entries` table, so:
 *
 *  - **`flattenRow`** lifts `data_json` keys to the top level, which is
 *    how `fields` projection and populate leaves keep working unchanged.
 *  - **relations** become `entryRelation` defs discriminated by
 *    `fieldApiId`.
 *  - **`filterable`** lists only the columns a filter can actually use
 *    efficiently. A non-promoted document field is deliberately NOT
 *    filterable here: `json_extract` is O(N) in document size on SQLite,
 *    so allowing it would turn one careless query param into a full scan
 *    of every entry. Promote the field (a real generated column plus a
 *    real index) and it becomes filterable.
 */
import { sql } from "drizzle-orm";
import type { CollectionDef, RelationDef } from "../query/registry";
import { entries } from "./schema";
import { promotedColumnName } from "./promote";
import {
  RELATIONAL_FIELD_TYPES,
  type ComponentFieldConfig,
  type RelationFieldConfig,
} from "./types";
import type { CollectionWithFields } from "./service";

/**
 * Columns of `entries` that are always safe to expose. `collection_id`
 * is omitted — it is an internal join key, and the caller already knows
 * which collection they queried.
 */
const BASE_SELECTABLE = [
  "id",
  "slug",
  "status",
  "publishedAt",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Real columns on `entries`, so these are indexed and cheap to filter
 * and sort by.
 */
const BASE_FILTERABLE = [
  "id",
  "slug",
  "status",
  "publishedAt",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Build a `CollectionDef` for one registry collection.
 *
 * `collectionId` is captured so the engine's base query can be scoped to
 * this collection's entries — see `scopeFilter`.
 */
export function toCollectionDef(
  collection: CollectionWithFields,
): CollectionDef {
  const documentFields = collection.fields.filter(
    (f) => !RELATIONAL_FIELD_TYPES.has(f.type),
  );

  const selectable = [
    ...BASE_SELECTABLE,
    ...documentFields.map((f) => f.apiId),
  ];

  // Only promoted fields join the filterable set. See the module note:
  // an unpromoted JSON field would be an O(N)-per-row scan.
  const promoted = documentFields
    .filter((f) => f.promoted && !f.localized)
    .map((f) => f.apiId);

  const relations: Record<string, RelationDef> = {};
  for (const field of collection.fields) {
    if (!RELATIONAL_FIELD_TYPES.has(field.type)) continue;
    const config = parseConfig(field.configJson);
    if (field.type === "relation") {
      const cfg = config as RelationFieldConfig;
      relations[field.apiId] = {
        kind: "entryRelation",
        fieldApiId: field.apiId,
        target: cfg.target,
        cardinality: cfg.cardinality ?? "one",
      };
    } else {
      const cfg = config as ComponentFieldConfig;
      relations[field.apiId] = {
        kind: "entryRelation",
        fieldApiId: field.apiId,
        // A dynamic zone may allow several component collections. The
        // engine loads one target collection per relation, so a
        // multi-allowed zone resolves against the first; mixed zones
        // need per-edge type resolution, which lands with the Phase 4
        // block editor that actually renders them.
        target: cfg.allowed[0],
        cardinality: cfg.cardinality ?? "many",
      };
    }
  }

  // Localized fields are exposed as a `localizations` relation, matching
  // the built-in collections' shape so a consumer sees one convention.
  const localizedFields = documentFields.filter((f) => f.localized);
  if (collection.localized && localizedFields.length > 0) {
    relations.localizations = {
      kind: "entryLocalizations",
      fields: localizedFields.map((f) => f.apiId),
    };
  }

  return {
    apiId: collection.apiId,
    table: entries,
    primaryKey: "id",
    selectable,
    filterable: [...BASE_FILTERABLE, ...promoted],
    relations,
    flattenRow: flattenEntryRow,
    scopeFilter: sql`${entries.collectionId} = ${collection.id}`,
  };
}

/**
 * Lift `data_json` keys onto the row.
 *
 * Base columns win on collision: a field named `status` cannot shadow
 * the entry's real status. `assertValidApiId` already rejects those
 * names, so this is belt-and-braces against a row written before that
 * validation existed.
 */
function flattenEntryRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const doc = safeParse(row.dataJson);
  return { ...doc, ...row };
}

function parseConfig(json: string | null): unknown {
  return json ? safeParse(json) : {};
}

function safeParse(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Promoted-column name, for callers building their own SQL. */
export { promotedColumnName };
