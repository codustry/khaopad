import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Integration tests against REAL SQLite, using the REAL migration files.
 *
 * ## Why these exist
 *
 * Every SQL-behaviour claim in Phases 1–4 was verified by hand in
 * throwaway scripts that were then deleted. The unit tests added in #103
 * cover arithmetic and encoding but explicitly do NOT execute SQL, so
 * nothing guarded the constraints, indexes or query semantics that the
 * whole design rests on.
 *
 * Three bugs this milestone shipped or nearly shipped would have been
 * caught here:
 *
 *   - `unique` silently unenforced on promoted fields
 *   - a nullable column inside a UNIQUE index making it inert
 *   - a duplicate migration file blocking the chain, while a test passed
 *     against stale schema
 *
 * ## What this is NOT
 *
 * better-sqlite3 is not D1. It shares SQLite's engine — so constraints,
 * indexes, query plans and type affinity all behave identically, which is
 * what these tests assert. It does NOT reproduce D1's bound-parameter
 * ceiling, its HTTP transport, or its replication. Those need a Miniflare
 * harness and are called out where relevant.
 *
 * Applying the real `drizzle/*.sql` files (rather than a hand-written
 * schema) is deliberate: it means a migration that fails to apply — or a
 * stray duplicate file — fails the suite rather than being invisible.
 */
const MIGRATIONS_DIR = new URL("../../../../drizzle", import.meta.url).pathname;

function applyMigrations(db: Database.Database): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    // Drizzle separates statements with this marker; splitting on it
    // rather than on ";" keeps CHECK constraints and triggers intact.
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        db.exec(trimmed);
      } catch (err) {
        // Preserve the cause: the SQLite message is the whole diagnostic
        // value here, and a duplicate migration file surfaces as
        // "table X already exists" only in the original error.
        throw new Error(
          `Migration ${file} failed: ${(err as Error).message}\n\n${trimmed.slice(0, 300)}`,
          { cause: err },
        );
      }
    }
  }
  return files;
}

let db: Database.Database;
let migrationFiles: string[];

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrationFiles = applyMigrations(db);
});

describe("migrations", () => {
  it("apply cleanly in filename order", () => {
    // A duplicate like `0020_collection_registry 2.sql` re-runs CREATE
    // TABLE and silently blocks everything after it. That happened, and
    // a constraint test then passed against the OLD schema.
    expect(migrationFiles.length).toBeGreaterThan(20);
  });

  it("have no duplicate-numbered files", () => {
    const numbers = migrationFiles.map((f) => f.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("create the Phase 2-4 tables", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
         ('collections','collection_fields','entries','entry_localizations',
          'entry_relations','entry_field_index','entry_versions',
          'attribute_definitions','attribute_values','attribute_families')`,
      )
      .all() as { name: string }[];
    expect(tables.length).toBe(10);
  });

  it("creates managed_secrets with the expected shape", () => {
    const cols = db.prepare(`PRAGMA table_info(managed_secrets)`).all() as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("key")?.pk).toBe(1);
    expect(byName.get("value_encrypted")?.notnull).toBe(1);
    expect(byName.get("updated_at")?.notnull).toBe(1);
    expect(byName.has("updated_by")).toBe(true);

    // There must be no column that could hold a plaintext value — the
    // whole security property is that this table only ever holds
    // ciphertext.
    expect(byName.has("value")).toBe(false);
  });
});

describe("entry_relations target shape (#99)", () => {
  beforeAll(() => {
    db.exec(`
      INSERT INTO collections (id,api_id,kind,draft_publish,localized,system,created_at,updated_at)
        VALUES ('c1','product','collection',1,1,0,'n','n');
      INSERT INTO entries (id,collection_id,slug,status,data_json,created_at,updated_at)
        VALUES ('e1','c1','a','published','{}','n','n'),
               ('e2','c1','b','published','{}','n','n');
    `);
  });

  const insertRel = (cols: string, vals: string) =>
    db.exec(`INSERT INTO entry_relations (${cols}) VALUES (${vals})`);

  it("accepts an entry-targeted edge", () => {
    expect(() =>
      insertRel(
        "id,entry_id,field_api_id,target_kind,target_entry_id,position,created_at",
        "'r1','e1','rel','entry','e2',0,'n'",
      ),
    ).not.toThrow();
  });

  it("accepts an external edge carrying edge attributes", () => {
    // `data_json` holds data belonging to the PAIRING — a confidence tier
    // on a "replaces" edge is a property of neither endpoint.
    expect(() =>
      insertRel(
        "id,entry_id,field_api_id,target_kind,target_namespace,target_ref,data_json,position,created_at",
        `'r2','e1','xref','external','acme','M-1','{"confidence":"exact"}',0,'n'`,
      ),
    ).not.toThrow();
    const row = db
      .prepare(`SELECT data_json FROM entry_relations WHERE id='r2'`)
      .get() as { data_json: string };
    expect(JSON.parse(row.data_json).confidence).toBe("exact");
  });

  it("rejects an external edge that also carries an entry id", () => {
    // Without the CHECK, populate would have to guess which target to
    // trust.
    expect(() =>
      insertRel(
        "id,entry_id,field_api_id,target_kind,target_entry_id,target_namespace,target_ref,position,created_at",
        "'r3','e1','xref','external','e2','acme','M-2',0,'n'",
      ),
    ).toThrow(/CHECK constraint/i);
  });

  it("rejects an entry edge with no target", () => {
    expect(() =>
      insertRel(
        "id,entry_id,field_api_id,target_kind,position,created_at",
        "'r4','e1','rel','entry',0,'n'",
      ),
    ).toThrow(/CHECK constraint/i);
  });

  it("rejects a duplicate ENTRY edge", () => {
    expect(() =>
      insertRel(
        "id,entry_id,field_api_id,target_kind,target_entry_id,position,created_at",
        "'r5','e1','rel','entry','e2',1,'n'",
      ),
    ).toThrow(/UNIQUE constraint/i);
  });

  it("rejects a duplicate EXTERNAL edge", () => {
    // THE case a single spanning index would miss: target_entry_id is
    // NULL for both rows, and SQLite treats NULLs as distinct in a UNIQUE
    // index. Two partial indexes are what make this fire.
    expect(() =>
      insertRel(
        "id,entry_id,field_api_id,target_kind,target_namespace,target_ref,position,created_at",
        "'r6','e1','xref','external','acme','M-1',1,'n'",
      ),
    ).toThrow(/UNIQUE constraint/i);
  });

  it("uses an index for the external reverse lookup", () => {
    // "Which entries reference acme/M-1?" powers cross-reference landing
    // pages; a scan there would be O(all relations).
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT entry_id FROM entry_relations
         WHERE target_namespace='acme' AND target_ref='M-1'`,
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX/);
  });
});

describe("attribute_values schema shape (#98)", () => {
  it("has an index keyed on the qualifier", () => {
    // Asserted on the INDEX rather than only via inserts, because if
    // `qualifier` drops out of the uniqueness key the seeding in
    // beforeAll fails and every test in this block is SKIPPED — and a
    // skip is far easier to overlook in CI output than a failure.
    const idx = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type='index' AND name='attribute_values_entity_attr_idx'`,
      )
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/qualifier/);
  });
});

describe("attribute_values interval + qualifier (#98)", () => {
  beforeAll(() => {
    db.exec(`
      INSERT INTO attribute_definitions
        (id,key,data_type,measure_family,standard_unit,better_direction,group_key,position,created_at,updated_at)
        VALUES ('a_flow','flow_rate','measurement','flow','m3/h','higher','perf',1,'n','n'),
               ('a_press','ultimate_pressure','measurement','pressure','Pa','lower','perf',2,'n','n');
      INSERT INTO attribute_values
        (id,entity_type,entity_id,attribute_id,locale,qualifier,value_number_min,value_number_max,value_unit,created_at,updated_at)
        VALUES
          ('v1','entry','p1','a_flow','*','50hz',80,80,'m3/h','n','n'),
          ('v2','entry','p1','a_flow','*','60hz',98,98,'m3/h','n','n'),
          ('v3','entry','p2','a_flow','*','*',150,170,'m3/h','n','n'),
          ('v4','entry','p3','a_flow','*','*',400,400,'m3/h','n','n'),
          ('v5','entry','p1','a_press','*','*',10,10,'mbar','n','n'),
          ('v6','entry','p2','a_press','*','*',50,50,'mbar','n','n');
    `);
  });

  it("stores a 50Hz and a 60Hz value on ONE attribute", () => {
    // Without `qualifier` in the uniqueness key these collide and the
    // second write overwrites the first.
    const rows = db
      .prepare(
        `SELECT qualifier FROM attribute_values
         WHERE entity_id='p1' AND attribute_id='a_flow' ORDER BY qualifier`,
      )
      .all() as { qualifier: string }[];
    expect(rows.map((r) => r.qualifier)).toEqual(["50hz", "60hz"]);
  });

  it("rejects a duplicate (entity, attribute, locale, qualifier)", () => {
    expect(() =>
      db.exec(
        `INSERT INTO attribute_values
           (id,entity_type,entity_id,attribute_id,locale,qualifier,value_number_min,value_number_max,created_at,updated_at)
         VALUES ('dup','entry','p1','a_flow','*','50hz',1,1,'n','n')`,
      ),
    ).toThrow(/UNIQUE constraint/i);
  });

  it("facets by interval OVERLAP, not a point test", () => {
    // p2's value is a genuine RANGE (150-170) that overlaps a 90-160
    // band. A point test on a single magnitude column would miss it or
    // force it into prose.
    const rows = db
      .prepare(
        `SELECT entity_id, qualifier FROM attribute_values
         WHERE attribute_id='a_flow'
           AND value_number_max >= 90 AND value_number_min <= 160
         ORDER BY entity_id`,
      )
      .all() as { entity_id: string; qualifier: string }[];
    expect(rows).toEqual([
      { entity_id: "p1", qualifier: "60hz" },
      { entity_id: "p2", qualifier: "*" },
    ]);
  });

  it("stores no spec as prose", () => {
    // #88's core complaint: half a real catalogue's specs fall through to
    // value_text under a single-magnitude model, losing faceting.
    const prose = db
      .prepare(
        `SELECT COUNT(*) n FROM attribute_values WHERE value_text IS NOT NULL`,
      )
      .get() as { n: number };
    expect(prose.n).toBe(0);
  });

  it("sorts best-first for a lower-is-better attribute", () => {
    const rows = db
      .prepare(
        `SELECT v.entity_id FROM attribute_values v
         JOIN attribute_definitions d ON d.id = v.attribute_id
         WHERE d.key='ultimate_pressure'
         ORDER BY CASE WHEN d.better_direction='lower'
                       THEN v.value_number_min
                       ELSE -v.value_number_min END ASC`,
      )
      .all() as { entity_id: string }[];
    // 10 Pa is a better vacuum than 50 Pa.
    expect(rows[0].entity_id).toBe("p1");
  });

  it("uses the numeric facet index rather than scanning", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT entity_id FROM attribute_values
         WHERE attribute_id='a_flow' AND value_number_min >= 100`,
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX/);
  });
});

describe("promoted generated columns", () => {
  it("extracts a JSON field and serves an index seek", () => {
    // The mechanism the whole registry design rests on: JSON-document
    // storage stays queryable because hot fields get a VIRTUAL generated
    // column plus an index. VIRTUAL specifically — SQLite cannot ADD a
    // STORED generated column to an existing table.
    db.exec(`
      ALTER TABLE entries ADD COLUMN q_product__sku TEXT
        AS (json_extract(data_json, '$.sku')) VIRTUAL;
      CREATE INDEX idx_q_product__sku ON entries(collection_id, q_product__sku);
      INSERT INTO entries (id,collection_id,slug,status,data_json,created_at,updated_at)
        VALUES ('e9','c1','sku-test','published','{"sku":"NW-A100"}','n','n');
    `);

    const row = db
      .prepare(`SELECT q_product__sku s FROM entries WHERE id='e9'`)
      .get() as { s: string };
    expect(row.s).toBe("NW-A100");

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM entries
         WHERE collection_id='c1' AND q_product__sku='NW-A100'`,
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX/);
  });
});

describe("entries collection scoping", () => {
  it("keeps content types isolated in the shared table", () => {
    // Every registry collection lives in `entries`, so a query for one
    // type must never return another's rows. The engine applies this via
    // scopeFilter; here we assert the data supports it.
    db.exec(`
      INSERT INTO collections (id,api_id,kind,draft_publish,localized,system,created_at,updated_at)
        VALUES ('c2','memo','collection',1,1,0,'n','n');
      INSERT INTO entries (id,collection_id,slug,status,data_json,created_at,updated_at)
        VALUES ('m1','c2','secret','published','{}','n','n');
    `);
    const rows = db
      .prepare(`SELECT id FROM entries WHERE collection_id='c2'`)
      .all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["m1"]);
  });

  it("scopes slug uniqueness per collection", () => {
    // Two different types may both legitimately have an "about" entry.
    expect(() =>
      db.exec(
        `INSERT INTO entries (id,collection_id,slug,status,data_json,created_at,updated_at)
         VALUES ('m2','c2','a','published','{}','n','n')`,
      ),
    ).not.toThrow();
    // But not twice within one collection.
    expect(() =>
      db.exec(
        `INSERT INTO entries (id,collection_id,slug,status,data_json,created_at,updated_at)
         VALUES ('m3','c2','a','published','{}','n','n')`,
      ),
    ).toThrow(/UNIQUE constraint/i);
  });
});
