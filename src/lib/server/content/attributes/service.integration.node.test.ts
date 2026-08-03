import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { AttributeService, AttributeError } from "./service";

/**
 * removeValue / listEntityValues (#130) against REAL SQLite with the
 * real migrations, following service.integration.node.test.ts in
 * secrets/. What matters here is the sentinel discipline: values are
 * keyed by (entity, attribute, locale, qualifier) with '*' standing in
 * for "none", so a remove must hit exactly one row and never a
 * qualified or localized sibling.
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

function valueRows(): { qualifier: string; locale: string }[] {
  return sqlite
    .prepare(
      `SELECT qualifier, locale FROM attribute_values ORDER BY qualifier, locale`,
    )
    .all() as { qualifier: string; locale: string }[];
}

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

describe("removeValue", () => {
  it("deletes ONLY the qualified row it names, not the siblings", async () => {
    await service.createAttribute({ key: "pumping_speed", dataType: "number" });
    await service.setValue(
      "entry",
      "e1",
      "pumping_speed",
      { kind: "number", value: 80 },
      "50hz",
    );
    await service.setValue(
      "entry",
      "e1",
      "pumping_speed",
      { kind: "number", value: 98 },
      "60hz",
    );
    await service.setValue("entry", "e1", "pumping_speed", {
      kind: "number",
      value: 90,
    });

    await service.removeValue("entry", "e1", "pumping_speed", "50hz");

    // The 60 Hz sibling and the unqualified (sentinel) row must survive.
    expect(valueRows()).toEqual([
      { qualifier: "*", locale: "*" },
      { qualifier: "60hz", locale: "*" },
    ]);
  });

  it("with no qualifier deletes only the UNQUALIFIED sentinel row", async () => {
    await service.createAttribute({ key: "pumping_speed", dataType: "number" });
    await service.setValue(
      "entry",
      "e1",
      "pumping_speed",
      { kind: "number", value: 80 },
      "50hz",
    );
    await service.setValue("entry", "e1", "pumping_speed", {
      kind: "number",
      value: 90,
    });

    await service.removeValue("entry", "e1", "pumping_speed");

    expect(valueRows()).toEqual([{ qualifier: "50hz", locale: "*" }]);
  });

  it("respects locale: removing the 'en' text leaves the non-localized row", async () => {
    await service.createAttribute({ key: "note", dataType: "text" });
    await service.setValue("entry", "e1", "note", {
      kind: "text",
      value: "for everyone",
    });
    await service.setValue("entry", "e1", "note", {
      kind: "text",
      value: "english only",
      locale: "en",
    });

    await service.removeValue("entry", "e1", "note", undefined, "en");

    expect(valueRows()).toEqual([{ qualifier: "*", locale: "*" }]);
  });

  it("never touches another entity's rows", async () => {
    await service.createAttribute({ key: "weight", dataType: "number" });
    await service.setValue("entry", "e1", "weight", {
      kind: "number",
      value: 22,
    });
    await service.setValue("entry", "e2", "weight", {
      kind: "number",
      value: 30,
    });

    await service.removeValue("entry", "e1", "weight");

    const remaining = sqlite
      .prepare(`SELECT entity_id FROM attribute_values`)
      .all() as { entity_id: string }[];
    expect(remaining).toEqual([{ entity_id: "e2" }]);
  });

  it("throws UNKNOWN_ATTRIBUTE for a key that does not exist", async () => {
    await expect(
      service.removeValue("entry", "e1", "no_such_attribute"),
    ).rejects.toMatchObject({
      name: "AttributeError",
      code: "UNKNOWN_ATTRIBUTE",
    });
    await expect(
      service.removeValue("entry", "e1", "no_such_attribute"),
    ).rejects.toBeInstanceOf(AttributeError);
  });
});

describe("listEntityValues (what the entry editor renders)", () => {
  it("maps the sentinels back to null and keeps real qualifiers", async () => {
    await service.createAttribute({ key: "pumping_speed", dataType: "number" });
    await service.setValue(
      "entry",
      "e1",
      "pumping_speed",
      { kind: "number", value: 80 },
      "50hz",
    );
    await service.setValue("entry", "e1", "pumping_speed", {
      kind: "number",
      value: 90,
    });

    const rows = await service.listEntityValues("entry", "e1");
    const qualifiers = rows.map((r) => r.qualifier).sort();
    expect(qualifiers).toEqual([null, "50hz"].sort());
    for (const row of rows) expect(row.locale).toBeNull();
  });

  it("returns a measurement range in the AUTHORED unit", async () => {
    await service.createAttribute({
      key: "weight",
      dataType: "measurement",
      measureFamily: "mass",
    });
    // Stored canonically in grams (22000–25000); the editor must see kg.
    await service.setValue("entry", "e1", "weight", {
      kind: "measurement",
      value: 22,
      max: 25,
      unit: "kg",
    });

    const [row] = await service.listEntityValues("entry", "e1");
    expect(row.displayValue).toBe(22);
    expect(row.displayValueMax).toBe(25);
    expect(row.unit).toBe("kg");
    expect(row.standardValue).toBe(22000);
    expect(row.standardValueMax).toBe(25000);
  });

  it("reports null displayValueMax for a scalar, so no spurious dash renders", async () => {
    await service.createAttribute({
      key: "weight",
      dataType: "measurement",
      measureFamily: "mass",
    });
    await service.setValue("entry", "e1", "weight", {
      kind: "measurement",
      value: 22,
      unit: "kg",
    });

    const [row] = await service.listEntityValues("entry", "e1");
    expect(row.displayValue).toBe(22);
    expect(row.displayValueMax).toBeNull();
  });

  it("keeps a localized text row's locale so a remove can target it", async () => {
    await service.createAttribute({ key: "note", dataType: "text" });
    await service.setValue("entry", "e1", "note", {
      kind: "text",
      value: "english",
      locale: "en",
    });

    const [row] = await service.listEntityValues("entry", "e1");
    expect(row.locale).toBe("en");
    expect(row.displayValue).toBe("english");
  });
});
