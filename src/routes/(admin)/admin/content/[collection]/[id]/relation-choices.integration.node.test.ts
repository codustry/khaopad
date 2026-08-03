import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { buildRelationChoices } from "./relation-choices.server";
import type { CollectionField } from "$lib/server/content/registry/schema";
import type { CollectionWithFieldsLike } from "./relation-choices.server";

/**
 * The property under test is the #126 data-loss fix: the picker posts
 * the FULL desired id list on save, so any currently-selected target
 * missing from the offered choices is silently deleted by the next
 * save. These tests run against real SQLite with the real migrations,
 * following service.integration.node.test.ts.
 */
const MIGRATIONS_DIR = new URL("../../../../../../../drizzle", import.meta.url)
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

const NOW = "2026-01-01T00:00:00.000Z";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

function field(
  apiId: string,
  type: "relation" | "component" | "text",
  config: unknown = null,
  extra: Partial<CollectionField> = {},
): CollectionField {
  return {
    id: `field-${apiId}`,
    collectionId: extra.collectionId ?? "owner",
    apiId,
    type,
    labelsJson: null,
    required: false,
    localized: false,
    unique: false,
    promoted: false,
    configJson: config ? JSON.stringify(config) : null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function insertCollection(id: string, apiId: string) {
  sqlite
    .prepare(
      `INSERT INTO collections (id, api_id, kind, draft_publish, localized, system, created_at, updated_at)
       VALUES (?, ?, 'collection', 1, 1, 0, ?, ?)`,
    )
    .run(id, apiId, NOW, NOW);
}

function insertEntry(
  id: string,
  collectionId: string,
  slug: string | null,
  dataJson = "{}",
) {
  sqlite
    .prepare(
      `INSERT INTO entries (id, collection_id, slug, status, data_json, created_at, updated_at)
       VALUES (?, ?, ?, 'published', ?, ?, ?)`,
    )
    .run(id, collectionId, slug, dataJson, NOW, NOW);
}

function insertLocalization(entryId: string, locale: string, dataJson: string) {
  sqlite
    .prepare(
      `INSERT INTO entry_localizations (id, entry_id, locale, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`loc-${entryId}-${locale}`, entryId, locale, dataJson, NOW, NOW);
}

function collectionWithFields(
  id: string,
  apiId: string,
  fields: CollectionField[] = [],
): CollectionWithFieldsLike {
  return {
    id,
    apiId,
    kind: "collection",
    labelsJson: null,
    draftPublish: true,
    localized: true,
    system: false,
    description: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    fields,
  };
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
  db = drizzle(d1Shim(sqlite));
  insertCollection("brand-col", "brands");
  insertCollection("tag-col", "tags");
});

describe("selected targets always survive the window (#126)", () => {
  it("unions a selected target that falls OUTSIDE the choice limit", async () => {
    // Window of 3, sorted by slug — the selected 'zzz-brand' would never
    // make it in on its own.
    for (let i = 0; i < 5; i++) {
      insertEntry(`b${i}`, "brand-col", `brand-${i}`);
    }
    insertEntry("bz", "brand-col", "zzz-brand");

    const { choices, totals } = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: { brand: ["bz"] },
      defaultLocale: "en",
      query: "",
      limit: 3,
    });

    const ids = choices.brand.map((c) => c.id);
    expect(ids).toContain("bz");
    // The window itself stays capped; only the selected row is added.
    expect(ids.length).toBe(4);
    expect(totals.brand).toBe(6);
  });

  it("keeps the selected target when a search query does not match it", async () => {
    insertEntry("b1", "brand-col", "acme");
    insertEntry("b2", "brand-col", "busch");

    const { choices, totals } = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: { brand: ["b1"] },
      defaultLocale: "en",
      query: "busch",
      limit: 10,
    });

    const ids = choices.brand.map((c) => c.id);
    // The filtered window has only b2, but the selection must survive —
    // dropping it is exactly the save-time data loss being prevented.
    expect(ids).toContain("b2");
    expect(ids).toContain("b1");
    expect(totals.brand).toBe(1);
  });

  it("round-trips an external `ns:ref` selection verbatim", async () => {
    const { choices } = await buildRelationChoices(db, {
      fields: [
        field("xref", "relation", { target: "brands", allowExternal: true }),
      ],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: { xref: ["busch:R5-KA-0100"] },
      defaultLocale: "en",
      query: "",
      limit: 10,
    });

    expect(choices.xref).toContainEqual({
      id: "busch:R5-KA-0100",
      label: "busch:R5-KA-0100",
    });
  });
});

describe("search reaches entries beyond the window", () => {
  it("finds an entry by slug that the unfiltered window would truncate away", async () => {
    for (let i = 0; i < 5; i++) {
      insertEntry(`b${i}`, "brand-col", `brand-${i}`);
    }
    insertEntry("target", "brand-col", "zz-special-pump");

    const unfiltered = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: {},
      defaultLocale: "en",
      query: "",
      limit: 3,
    });
    expect(unfiltered.choices.brand.map((c) => c.id)).not.toContain("target");

    const filtered = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: {},
      defaultLocale: "en",
      query: "special",
      limit: 3,
    });
    expect(filtered.choices.brand.map((c) => c.id)).toContain("target");
    expect(filtered.totals.brand).toBe(1);
  });

  it("matches inside a localization document", async () => {
    insertEntry("b1", "brand-col", "acme");
    insertLocalization("b1", "en", JSON.stringify({ title: "Findable Name" }));
    insertEntry("b2", "brand-col", "other");

    const { choices } = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: {},
      defaultLocale: "en",
      query: "Findable",
      limit: 10,
    });
    expect(choices.brand.map((c) => c.id)).toEqual(["b1"]);
  });

  it("treats LIKE metacharacters in the query as literals", async () => {
    insertEntry("b1", "brand-col", "acme");
    const { choices } = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: {},
      defaultLocale: "en",
      // A bare '%' must not match everything.
      query: "%",
      limit: 10,
    });
    expect(choices.brand).toEqual([]);
  });
});

describe("labels", () => {
  it("uses `name (slug)` from a non-localized text field", async () => {
    insertEntry("b1", "brand-col", "busch", JSON.stringify({ name: "Busch" }));
    const { choices } = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [
        collectionWithFields("brand-col", "brands", [
          field("name", "text", null, { collectionId: "brand-col" }),
        ]),
      ],
      selected: {},
      defaultLocale: "en",
      query: "",
      limit: 10,
    });
    expect(choices.brand).toEqual([{ id: "b1", label: "Busch (busch)" }]);
  });

  it("reads a LOCALIZED title from the default locale's document", async () => {
    insertEntry("b1", "brand-col", "hello-page");
    insertLocalization("b1", "en", JSON.stringify({ title: "Hello Page" }));
    insertLocalization("b1", "th", JSON.stringify({ title: "หน้าสวัสดี" }));

    const { choices } = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [
        collectionWithFields("brand-col", "brands", [
          field("title", "text", null, {
            collectionId: "brand-col",
            localized: true,
          }),
        ]),
      ],
      selected: {},
      defaultLocale: "en",
      query: "",
      limit: 10,
    });
    expect(choices.brand).toEqual([
      { id: "b1", label: "Hello Page (hello-page)" },
    ]);
  });

  it("falls back to slug, then to id", async () => {
    insertEntry("with-slug", "brand-col", "just-a-slug");
    insertEntry("no-slug", "brand-col", null);
    const { choices } = await buildRelationChoices(db, {
      fields: [field("brand", "relation", { target: "brands" })],
      targetCollections: [collectionWithFields("brand-col", "brands")],
      selected: {},
      defaultLocale: "en",
      query: "",
      limit: 10,
    });
    const byId = new Map(choices.brand.map((c) => [c.id, c.label]));
    expect(byId.get("with-slug")).toBe("just-a-slug");
    expect(byId.get("no-slug")).toBe("no-slug");
  });
});

describe("per-field scoping", () => {
  it("each field only offers entries of its allowed collections", async () => {
    insertEntry("b1", "brand-col", "busch");
    insertEntry("t1", "tag-col", "vacuum");

    const { choices, totals } = await buildRelationChoices(db, {
      fields: [
        field("brand", "relation", { target: "brands" }),
        field("tags", "relation", { target: "tags" }),
      ],
      targetCollections: [
        collectionWithFields("brand-col", "brands"),
        collectionWithFields("tag-col", "tags"),
      ],
      selected: {},
      defaultLocale: "en",
      query: "",
      limit: 10,
    });

    expect(choices.brand.map((c) => c.id)).toEqual(["b1"]);
    expect(choices.tags.map((c) => c.id)).toEqual(["t1"]);
    expect(totals.brand).toBe(1);
    expect(totals.tags).toBe(1);
  });

  it("component fields aggregate every `allowed` collection", async () => {
    insertEntry("b1", "brand-col", "busch");
    insertEntry("t1", "tag-col", "vacuum");

    const { choices, totals } = await buildRelationChoices(db, {
      fields: [field("zone", "component", { allowed: ["brands", "tags"] })],
      targetCollections: [
        collectionWithFields("brand-col", "brands"),
        collectionWithFields("tag-col", "tags"),
      ],
      selected: {},
      defaultLocale: "en",
      query: "",
      limit: 10,
    });

    expect(choices.zone.map((c) => c.id).sort()).toEqual(["b1", "t1"]);
    expect(totals.zone).toBe(2);
  });
});
