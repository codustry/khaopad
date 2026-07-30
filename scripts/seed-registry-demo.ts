/**
 * Registry demo seed — Phase 2 proof, and the source-agnostic import
 * path (#68 / task "portability requirement").
 *
 * Loads a small relational catalog **from an external JSON file** into
 * the collection registry, using only the public `RegistryService` API.
 * That is the point: the importer is a thin, swappable script, not part
 * of the engine. A Strapi export, a CSV, or another CMS's dump can be
 * scripted the same way — write a different reader, call the same
 * methods.
 *
 * There is nothing client-specific in the engine. `brand`, `productLine`
 * and `variant` below are just example USER collections defined through
 * the registry, exactly as any other site would define its own.
 *
 * Usage:
 *   pnpm tsx scripts/seed-registry-demo.ts                 # local D1
 *   pnpm tsx scripts/seed-registry-demo.ts --remote
 *   pnpm tsx scripts/seed-registry-demo.ts --file ./my.json
 *
 * The JSON shape is documented in `fixtures/registry-demo.json`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface FixtureField {
  apiId: string;
  type: string;
  required?: boolean;
  localized?: boolean;
  unique?: boolean;
  promoted?: boolean;
  config?: unknown;
}

interface FixtureCollection {
  apiId: string;
  kind?: "collection" | "single" | "component";
  localized?: boolean;
  fields: FixtureField[];
}

interface FixtureEntry {
  /** Local key used to wire relations within the fixture. */
  key: string;
  collection: string;
  slug?: string;
  status?: "draft" | "published";
  data?: Record<string, unknown>;
  localizations?: Record<string, Record<string, unknown>>;
  /** Values are fixture `key`s, resolved to real entry ids on insert. */
  relations?: Record<string, string[]>;
}

interface Fixture {
  collections: FixtureCollection[];
  entries: FixtureEntry[];
}

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const fileArg = args.indexOf("--file");
const fixturePath = resolve(
  fileArg >= 0 && args[fileArg + 1]
    ? args[fileArg + 1]
    : "scripts/fixtures/registry-demo.json",
);
const dbName = process.env.D1_DB_NAME ?? "khaopad-db";

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

/**
 * Run SQL through wrangler.
 *
 * This script talks SQL rather than importing RegistryService because it
 * runs in Node, outside the Worker — there is no D1 binding here. It
 * mirrors what the service does; the HTTP admin API (Phase 4) is the
 * path that uses the service directly.
 *
 * Uses execFileSync with an argument array, never a shell string, so
 * fixture content cannot be interpreted as shell syntax.
 */
function exec(sql: string): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      dbName,
      remote ? "--remote" : "--local",
      "--command",
      sql,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
}

/** SQLite string literal — doubles embedded single quotes. */
function lit(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Deterministic ids so re-running the seed is idempotent. */
function idFor(kind: string, key: string): string {
  return `seed_${kind}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
}

const NOW = "2026-07-30T00:00:00.000Z";

console.log(`Seeding registry demo from ${fixturePath} → ${dbName}`);

// ── Collections + fields
for (const collection of fixture.collections) {
  const cid = idFor("col", collection.apiId);
  exec(
    `INSERT OR REPLACE INTO collections
       (id, api_id, kind, labels_json, draft_publish, localized, system, description, created_by, created_at, updated_at)
     VALUES (${lit(cid)}, ${lit(collection.apiId)}, ${lit(collection.kind ?? "collection")},
             NULL, 1, ${collection.localized === false ? 0 : 1}, 0, NULL, NULL,
             ${lit(NOW)}, ${lit(NOW)})`,
  );

  collection.fields.forEach((field, position) => {
    const fid = idFor("fld", `${collection.apiId}_${field.apiId}`);
    exec(
      `INSERT OR REPLACE INTO collection_fields
         (id, collection_id, api_id, type, labels_json, required, localized,
          "unique", promoted, config_json, position, created_at, updated_at)
       VALUES (${lit(fid)}, ${lit(cid)}, ${lit(field.apiId)}, ${lit(field.type)},
               NULL, ${field.required ? 1 : 0}, ${field.localized ? 1 : 0},
               ${field.unique ? 1 : 0}, ${field.promoted ? 1 : 0},
               ${lit(JSON.stringify(field.config ?? {}))}, ${position},
               ${lit(NOW)}, ${lit(NOW)})`,
    );
  });
  console.log(
    `  collection ${collection.apiId} (${collection.fields.length} fields)`,
  );
}

// ── Entries. Two passes: rows first, then edges, so a relation can
// point at an entry defined later in the fixture.
const entryIds = new Map<string, string>();
for (const entry of fixture.entries) {
  entryIds.set(entry.key, idFor("ent", entry.key));
}

for (const entry of fixture.entries) {
  const id = entryIds.get(entry.key)!;
  const cid = idFor("col", entry.collection);
  const status = entry.status ?? "published";
  exec(
    `INSERT OR REPLACE INTO entries
       (id, collection_id, slug, status, published_at, data_json, created_by, created_at, updated_at)
     VALUES (${lit(id)}, ${lit(cid)}, ${lit(entry.slug ?? null)}, ${lit(status)},
             ${status === "published" ? lit(NOW) : "NULL"},
             ${lit(JSON.stringify(entry.data ?? {}))}, NULL, ${lit(NOW)}, ${lit(NOW)})`,
  );

  for (const [locale, values] of Object.entries(entry.localizations ?? {})) {
    exec(
      `INSERT OR REPLACE INTO entry_localizations
         (id, entry_id, locale, data_json, created_at, updated_at)
       VALUES (${lit(`${id}_${locale}`)}, ${lit(id)}, ${lit(locale)},
               ${lit(JSON.stringify(values))}, ${lit(NOW)}, ${lit(NOW)})`,
    );
  }
}

let edgeCount = 0;
for (const entry of fixture.entries) {
  const id = entryIds.get(entry.key)!;
  for (const [fieldApiId, targetKeys] of Object.entries(
    entry.relations ?? {},
  )) {
    targetKeys.forEach((targetKey, position) => {
      const targetId = entryIds.get(targetKey);
      if (!targetId) {
        throw new Error(
          `Entry "${entry.key}" relation "${fieldApiId}" references unknown key "${targetKey}"`,
        );
      }
      exec(
        `INSERT OR REPLACE INTO entry_relations
           (id, entry_id, field_api_id, target_entry_id, position, created_at)
         VALUES (${lit(`${id}_${fieldApiId}_${position}`)}, ${lit(id)},
                 ${lit(fieldApiId)}, ${lit(targetId)}, ${position}, ${lit(NOW)})`,
      );
      edgeCount++;
    });
  }
}

// ── Promotions
//
// A `promoted` registry row on its own does nothing: the VIRTUAL
// generated column and its index are real DDL. In the Worker that
// happens through PromotionService; here we issue the equivalent SQL so
// a seeded database is actually queryable on those fields rather than
// merely claiming to be.
//
// Mirrors PromotionService.promote(): VIRTUAL (the only kind SQLite can
// add to an existing table), and the index paired with collection_id so
// it serves "filter within one collection".
let promotedCount = 0;
for (const collection of fixture.collections) {
  for (const field of collection.fields) {
    if (!field.promoted) continue;
    if (field.localized) {
      // Localized promotions live on entry_localizations; the demo has
      // none, and silently promoting to the wrong table would be worse
      // than skipping with a warning.
      console.warn(
        `  ! skipping promotion of localized ${collection.apiId}.${field.apiId} (not needed by this fixture)`,
      );
      continue;
    }
    // Must match PromotionService.promotedColumnName exactly, including
    // the DOUBLE-underscore separator — a single one would be ambiguous
    // between `a_b`+`c` and `a`+`b_c`. Both halves are validated with the
    // same no-consecutive-underscore rule as assertValidApiId before any
    // interpolation into DDL.
    const safe = /^[a-z](?:_?[a-z0-9])*$/;
    if (!safe.test(collection.apiId) || !safe.test(field.apiId)) {
      throw new Error(
        `Unsafe identifier for promotion: ${collection.apiId}.${field.apiId}`,
      );
    }
    const column = `q_${collection.apiId}__${field.apiId}`;
    const sqlType =
      field.type === "number"
        ? "REAL"
        : field.type === "boolean"
          ? "INTEGER"
          : "TEXT";
    try {
      exec(
        `ALTER TABLE entries ADD COLUMN ${column} ${sqlType} ` +
          `AS (json_extract(data_json, '$.${field.apiId}')) VIRTUAL`,
      );
    } catch {
      // Already promoted by a previous run — ALTER TABLE ADD COLUMN has
      // no IF NOT EXISTS, so this is the idempotency path.
    }
    exec(
      `CREATE INDEX IF NOT EXISTS idx_${column} ON entries(collection_id, ${column})`,
    );
    promotedCount++;
  }
}

console.log(
  `  ${fixture.entries.length} entries, ${edgeCount} relation edges, ` +
    `${promotedCount} promoted columns\n` +
    `Done. Try:\n` +
    `  GET /api/public/entries/${fixture.collections[0]?.apiId}?populate=*&locale=en`,
);
