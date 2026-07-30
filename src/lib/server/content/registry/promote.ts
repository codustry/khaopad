/**
 * Hot-field promotion — Phase 2, the "inverted index" for hot paths.
 *
 * SQLite's `json_extract` is **O(N) in the document size, not O(1)**
 * (see SQLite's json1 docs — its JSONB format makes no O(1) claim). So
 * an unindexed filter over a JSON field is a full scan of every row's
 * document. For a field users actually filter or sort by, that is the
 * difference between a working catalog and a broken one.
 *
 * The fix Cloudflare explicitly recommends:
 *
 *   > "If you have JSON data that you frequently query and filter over,
 *   > creating a generated column and an index can dramatically improve
 *   > query performance."
 *
 * So a field marked `promoted` gets:
 *
 *   ALTER TABLE entries ADD COLUMN q_<field> TEXT
 *     AS (json_extract(data_json, '$.<field>')) VIRTUAL;
 *   CREATE INDEX IF NOT EXISTS ... ON entries(collection_id, q_<field>);
 *
 * ## Why VIRTUAL, not STORED
 *
 * SQLite permits **only VIRTUAL** generated columns to be added by
 * `ALTER TABLE` — STORED cannot be added to an existing table. Since
 * promotion happens at runtime against a populated table, VIRTUAL is
 * the only option. It costs no storage; the index over it is an
 * expression index, and generated columns can participate in indexes
 * like any other.
 *
 * ## Why this is bounded, and opt-in
 *
 * **D1 caps a table at 100 columns.** `entries` already spends 8, and
 * every promoted field across *every* collection spends another from
 * the same shared budget. This is the real ceiling on the design — not
 * join performance — and it is why promotion is an explicit per-field
 * opt-in with a hard budget check rather than something the engine does
 * automatically. SonicJS, which ships this same design on D1, hit and
 * documents the identical wall.
 *
 * ## Promoted columns are effectively permanent
 *
 * SQLite cannot drop a generated column that an index references, and D1
 * discourages destructive DDL, so `unpromote` drops only the index and
 * leaves the column inert. Two consequences worth knowing:
 *
 *  - un-promoting does NOT return budget; `budget()` reports that
 *    honestly rather than pretending the space came back
 *  - changing the column NAMING scheme orphans every existing promoted
 *    column, and the orphans keep consuming budget. If the scheme ever
 *    changes again it needs a real migration that rebuilds `entries`,
 *    not just a new format here.
 *
 * ## Injection safety
 *
 * DDL cannot use bound parameters — identifiers are not bindable — so
 * these statements are built by string interpolation. That is only safe
 * because the interpolated values are not free text: `apiId` has
 * already passed `assertValidApiId` (`^[a-z][a-z0-9_]{0,62}$`), so it
 * cannot contain a quote, space, semicolon or comment marker. This
 * module re-checks rather than trusting its caller, because a single
 * missed validation here is arbitrary SQL execution.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { FieldType } from "./schema";
import {
  assertValidApiId,
  PROMOTABLE_FIELD_TYPES,
  RegistryError,
} from "./types";

/** D1's hard per-table column ceiling. */
export const D1_MAX_COLUMNS = 100;

/**
 * Columns `entries` declares itself: id, collection_id, slug, status,
 * published_at, data_json, created_by, created_at, updated_at.
 *
 * Kept as a constant rather than counted at runtime so the budget is
 * legible here, and so a schema change that eats headroom shows up as a
 * deliberate edit to this number rather than silently shrinking it.
 */
const BASE_ENTRY_COLUMNS = 9;

/**
 * Deliberate safety margin. Running right up to 100 would leave no room
 * for a future engine column, and hitting the cap is unrecoverable
 * without a table rebuild — SQLite cannot drop a generated column
 * cleanly on D1.
 */
const PROMOTION_HEADROOM = 12;

export const MAX_PROMOTED_FIELDS =
  D1_MAX_COLUMNS - BASE_ENTRY_COLUMNS - PROMOTION_HEADROOM;

/** Prefix marking a column as engine-generated, not hand-declared. */
const PROMOTED_PREFIX = "q_";

/**
 * Generated-column name for a field.
 *
 * Namespaced by collection so two collections can both promote a field
 * called `title` — they are different JSON paths and must be different
 * columns.
 *
 * The separator is a DOUBLE underscore, not a single one. `API_ID_PATTERN`
 * permits single underscores inside a name, so `_` would be ambiguous:
 * collection `blog_post` + field `title` and collection `blog` + field
 * `post_title` would both produce `q_blog_post_title`. The second
 * promotion would then find the column already present, return a silent
 * no-op, and every filter on that field would read the *other*
 * collection's JSON path — wrong results with no error. `__` cannot
 * appear in a validated apiId, so the encoding is unambiguous.
 */
export function promotedColumnName(
  collectionApiId: string,
  fieldApiId: string,
): string {
  assertSafeIdentifier(collectionApiId, "collection apiId");
  assertSafeIdentifier(fieldApiId, "field apiId");
  return `${PROMOTED_PREFIX}${collectionApiId}__${fieldApiId}`;
}

/**
 * Re-validate an identifier immediately before it is interpolated into
 * DDL. Redundant with the service layer by design: this is the last
 * gate before string-built SQL, so it must not depend on a caller
 * having done the right thing.
 */
function assertSafeIdentifier(value: string, what: string): void {
  // Delegates to the shared validator so this gate can never drift from
  // the one the service applies — including the no-consecutive-
  // underscores rule that keeps `__` usable as a separator.
  try {
    assertValidApiId(value, what);
  } catch {
    throw new RegistryError(
      `Refusing to build DDL: unsafe ${what} "${value}"`,
      "INVALID_API_ID",
    );
  }
}

/** SQLite storage class for a promoted field. */
function sqliteTypeFor(type: FieldType): "TEXT" | "INTEGER" | "REAL" {
  switch (type) {
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER";
    default:
      return "TEXT";
  }
}

export interface PromotionTarget {
  collectionApiId: string;
  fieldApiId: string;
  fieldType: FieldType;
  /** True when the value lives in entry_localizations, not entries. */
  localized: boolean;
}

export class PromotionService {
  private db: ReturnType<typeof drizzle>;

  constructor(private readonly d1: D1Database) {
    this.db = drizzle(d1);
  }

  /**
   * Generated columns currently on a table, by name.
   *
   * Uses `table_xinfo` rather than `table_info` — the latter omits
   * generated columns entirely, so counting with it would under-report
   * the budget and let promotions exceed the column cap.
   */
  async listColumns(
    table: "entries" | "entry_localizations",
  ): Promise<string[]> {
    const rows = await this.d1
      .prepare(`PRAGMA table_xinfo(${table})`)
      .all<{ name: string }>();
    return (rows.results ?? []).map((r) => r.name);
  }

  /** How many promoted columns exist / remain. */
  async budget(): Promise<{ used: number; max: number; remaining: number }> {
    const [entryCols, locCols] = await Promise.all([
      this.listColumns("entries"),
      this.listColumns("entry_localizations"),
    ]);
    // Both tables draw on the same conceptual budget; report the worse
    // of the two so a promotion is refused before either table is at
    // risk.
    const used = Math.max(
      entryCols.filter((c) => c.startsWith(PROMOTED_PREFIX)).length,
      locCols.filter((c) => c.startsWith(PROMOTED_PREFIX)).length,
    );
    return {
      used,
      max: MAX_PROMOTED_FIELDS,
      remaining: Math.max(0, MAX_PROMOTED_FIELDS - used),
    };
  }

  /**
   * Add the generated column + index for a field. Idempotent: an
   * already-promoted field is a no-op, so this is safe to call on every
   * boot to reconcile the physical schema against the registry.
   *
   * Returns the column name, or null when it already existed.
   */
  async promote(target: PromotionTarget): Promise<string | null> {
    if (!PROMOTABLE_FIELD_TYPES.has(target.fieldType)) {
      throw new RegistryError(
        `Field type "${target.fieldType}" cannot be promoted to an indexed column`,
        "INVALID_CONFIG",
      );
    }

    const column = promotedColumnName(
      target.collectionApiId,
      target.fieldApiId,
    );
    const table = target.localized ? "entry_localizations" : "entries";

    const existing = await this.listColumns(table);
    if (existing.includes(column)) return null;

    const { remaining } = await this.budget();
    if (remaining <= 0) {
      throw new RegistryError(
        `Cannot promote "${target.collectionApiId}.${target.fieldApiId}": D1 allows ${D1_MAX_COLUMNS} columns per table and the promotion budget (${MAX_PROMOTED_FIELDS}) is exhausted. Un-promote a field first.`,
        "PROMOTION_BUDGET_EXCEEDED",
      );
    }

    const sqlType = sqliteTypeFor(target.fieldType);
    // Every interpolated value is validated: `column` came from
    // promotedColumnName (which re-checks both halves), `table` is one
    // of two literals, `sqlType` is one of three literals, and the JSON
    // path is built from the same validated apiId.
    const jsonPath = `$.${target.fieldApiId}`;

    await this.d1
      .prepare(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType} ` +
          `AS (json_extract(data_json, '${jsonPath}')) VIRTUAL`,
      )
      .run();

    // Index is (collection_id, promoted) on `entries` so it serves the
    // common "filter within one collection" query rather than a global
    // scan across every collection's entries. entry_localizations has no
    // collection_id, so it pairs with locale instead.
    const indexName = `idx_${column}`;
    const indexCols = target.localized
      ? `locale, ${column}`
      : `collection_id, ${column}`;
    await this.d1
      .prepare(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(${indexCols})`,
      )
      .run();

    return column;
  }

  /**
   * Drop the index for a promoted field.
   *
   * The generated **column is deliberately left in place**: SQLite's
   * `DROP COLUMN` refuses to remove a column referenced by an index and
   * is unsupported for generated columns on older engines, and D1
   * discourages destructive DDL. Dropping just the index reclaims the
   * write cost and the query planner stops using it; the column becomes
   * inert. It still counts against the budget, which `budget()` reports
   * honestly rather than pretending the space came back.
   */
  async unpromote(target: {
    collectionApiId: string;
    fieldApiId: string;
  }): Promise<void> {
    const column = promotedColumnName(
      target.collectionApiId,
      target.fieldApiId,
    );
    await this.d1.prepare(`DROP INDEX IF EXISTS idx_${column}`).run();
  }

  /**
   * Bring the physical schema in line with the registry: promote every
   * field marked `promoted` that lacks its column.
   *
   * Cheap and idempotent, so it can run at boot. Returns the columns it
   * actually added.
   *
   * Failures are collected rather than thrown: one field exhausting the
   * budget must not stop the rest of the schema from reconciling, and
   * the caller (an admin screen or a boot log) is better placed to
   * surface it than a half-applied exception.
   */
  async reconcile(
    targets: PromotionTarget[],
  ): Promise<{ added: string[]; failed: { field: string; reason: string }[] }> {
    const added: string[] = [];
    const failed: { field: string; reason: string }[] = [];
    for (const target of targets) {
      try {
        const column = await this.promote(target);
        if (column) added.push(column);
      } catch (err) {
        failed.push({
          field: `${target.collectionApiId}.${target.fieldApiId}`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { added, failed };
  }

  /**
   * Raw SQL fragment for a promoted column, for use in a WHERE/ORDER BY.
   * Callers must already know the field is promoted.
   */
  columnRef(collectionApiId: string, fieldApiId: string) {
    const column = promotedColumnName(collectionApiId, fieldApiId);
    return sql.raw(column);
  }
}
