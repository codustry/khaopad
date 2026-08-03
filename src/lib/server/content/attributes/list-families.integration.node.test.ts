import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { AttributeService } from "./service";

/**
 * Integration test for `listFamilies()` — the helper added for the
 * /admin/specs index (#130) — against real SQLite with the real
 * migrations applied (drizzle/0021_spec_attributes.sql).
 *
 * Same shim pattern as secrets/service.integration.node.test.ts.
 */
const MIGRATIONS_DIR = new URL("../../../../../drizzle", import.meta.url)
  .pathname;

/** Minimal D1Database shim over better-sqlite3, enough for Drizzle's d1 driver. */
function d1Shim(db: Database.Database): D1Database {
  const run = (sql: string, params: unknown[]) => {
    const stmt = db.prepare(sql.replace(/\?\d+/g, "?"));
    if (/^\s*(select|pragma)/i.test(sql)) {
      const results = stmt.all(...params);
      return { results, success: true, meta: {} };
    }
    const info = stmt.run(...params);
    return { results: [], success: true, meta: { changes: info.changes } };
  };
  const makeStmt = (sql: string, params: unknown[] = []): D1PreparedStatement =>
    ({
      bind: (...p: unknown[]) => makeStmt(sql, p),
      all: async () => run(sql, params),
      run: async () => run(sql, params),
      first: async (col?: string) => {
        const r = run(sql, params).results as Record<string, unknown>[];
        const row = r[0] ?? null;
        return col && row ? row[col] : row;
      },
      raw: async () =>
        (run(sql, params).results as Record<string, unknown>[]).map((r) =>
          Object.values(r),
        ),
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: D1PreparedStatement[]) =>
      Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

let sqlite: Database.Database;
let service: AttributeService;

beforeEach(() => {
  sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  service = new AttributeService(d1Shim(sqlite), {
    supportedLocales: ["en", "th"],
    defaultLocale: "en",
  });
});

describe("listFamilies", () => {
  it("returns an empty list before any family exists", async () => {
    expect(await service.listFamilies()).toEqual([]);
  });

  it("returns every family, alphabetically by key", async () => {
    // Inserted out of order to prove the ORDER BY, not insertion order.
    await service.createFamily({ key: "vacuum_pump" });
    await service.createFamily({ key: "blower", description: "Side channel" });

    const families = await service.listFamilies();
    expect(families.map((f) => f.key)).toEqual(["blower", "vacuum_pump"]);
    expect(families[0]!.description).toBe("Side channel");
  });

  it("round-trips with familyAttributeList for the admin page shape", async () => {
    // The /admin/specs loader iterates listFamilies() and calls
    // familyAttributeList(key) per row — assert the keys it returns are
    // accepted by that second call.
    await service.createFamily({ key: "vacuum_pump" });
    await service.createAttribute({
      key: "flow_rate",
      dataType: "measurement",
      measureFamily: "flow",
    });
    await service.addAttributeToFamily("vacuum_pump", "flow_rate", {
      required: true,
      sortOrder: 10,
    });

    const [family] = await service.listFamilies();
    const attrs = await service.familyAttributeList(family!.key);
    expect(attrs).toHaveLength(1);
    expect(attrs[0]!.attribute.key).toBe("flow_rate");
    expect(attrs[0]!.required).toBe(true);
    expect(attrs[0]!.sortOrder).toBe(10);
  });
});
