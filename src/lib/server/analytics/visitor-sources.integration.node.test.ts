import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { AnalyticsService, trackVisitorSource } from "./index";

/**
 * Visitor-sources storage against REAL SQLite with the REAL migrations
 * (0034 creates visitor_sources).
 *
 * The properties under test are the ones the design promises and that
 * a reviewer cannot verify by reading the query code alone:
 *
 *   1. No consent → no row, and no D1 round-trip at all.
 *   2. Repeat landings AGGREGATE rather than appending rows, so the
 *      table cannot reconstruct an individual's journey.
 *   3. A utm_source spray cannot grow the table without bound.
 */
const MIGRATIONS_DIR = new URL("../../../../drizzle", import.meta.url).pathname;

function applyMigrations(db: Database.Database) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
}

/** Minimal D1Database shim over better-sqlite3, counting round-trips. */
function d1Shim(db: Database.Database) {
  const calls = { prepare: 0 };
  const run = (sql: string, params: unknown[]) => {
    const stmt = db.prepare(sql);
    if (/^\s*(select|pragma)/i.test(sql) || /returning/i.test(sql)) {
      return { results: stmt.all(...params), success: true, meta: {} };
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

  const d1 = {
    prepare: (sql: string) => {
      calls.prepare++;
      return makeStmt(sql);
    },
    batch: async (stmts: D1PreparedStatement[]) =>
      Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
  return { d1, calls };
}

const YES = { analytics: true };
const NO = { analytics: false };
const SELF = "example.com";

function rows(db: Database.Database) {
  return db
    .prepare(`SELECT * FROM visitor_sources ORDER BY count DESC, source ASC`)
    .all() as Array<Record<string, unknown>>;
}

describe("visitor sources — storage", () => {
  let sqlite: Database.Database;
  let d1: D1Database;
  let calls: { prepare: number };

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    const shim = d1Shim(sqlite);
    d1 = shim.d1;
    calls = shim.calls;
  });

  describe("consent gate", () => {
    it("writes nothing and makes NO D1 round-trip without consent", async () => {
      const result = await trackVisitorSource(
        d1,
        {
          path: "/en/blog/hello",
          referrer: "https://www.google.com/search?q=x",
          params: new URLSearchParams("utm_source=news"),
          selfHost: SELF,
        },
        NO,
      );

      expect(result).toBeNull();
      expect(rows(sqlite)).toHaveLength(0);
      // The gate must short-circuit BEFORE touching D1 — not write and
      // roll back, and not prepare a statement it never runs.
      expect(calls.prepare).toBe(0);
    });

    it("writes exactly one row with consent", async () => {
      const result = await trackVisitorSource(
        d1,
        {
          path: "/en/blog/hello",
          referrer: "https://www.google.com/search?q=x",
          params: new URLSearchParams(),
          selfHost: SELF,
        },
        YES,
      );

      expect(result).toMatchObject({
        channel: "organic_search",
        source: "google",
      });
      const all = rows(sqlite);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        channel: "organic_search",
        source: "google",
        medium: "organic",
        campaign: "none",
        path: "/en/blog/hello",
        count: 1,
      });
    });

    it("stores no full referrer URL anywhere in the row", async () => {
      await trackVisitorSource(
        d1,
        {
          path: "/en",
          referrer: "https://www.google.co.th/search?q=private+search+terms",
          params: new URLSearchParams(),
          selfHost: SELF,
        },
        YES,
      );
      const serialized = JSON.stringify(rows(sqlite));
      expect(serialized).not.toContain("private");
      expect(serialized).not.toContain("search?q");
      expect(serialized).not.toContain("/search");
    });
  });

  describe("aggregate shape", () => {
    it("bumps a counter instead of appending a row per visit", async () => {
      for (let i = 0; i < 5; i++) {
        await trackVisitorSource(
          d1,
          {
            path: "/en/blog/hello",
            referrer: "https://t.co/abc",
            params: new URLSearchParams(),
            selfHost: SELF,
          },
          YES,
        );
      }
      const all = rows(sqlite);
      expect(all).toHaveLength(1);
      expect(all[0].count).toBe(5);
      // Five visits, one row, no timestamps: nothing here says whether
      // that was one person five times or five people once.
      expect(Object.keys(all[0])).toEqual([
        "date",
        "channel",
        "source",
        "medium",
        "campaign",
        "path",
        "count",
      ]);
    });

    it("keeps distinct dimensions on separate rows", async () => {
      const landings: Array<[string | null, string]> = [
        ["https://t.co/a", "/en"],
        ["https://www.google.com/", "/en"],
        [null, "/en"],
        ["https://t.co/a", "/th"],
      ];
      for (const [referrer, path] of landings) {
        await trackVisitorSource(
          d1,
          { path, referrer, params: new URLSearchParams(), selfHost: SELF },
          YES,
        );
      }
      expect(rows(sqlite)).toHaveLength(4);
    });
  });

  describe("cardinality cap", () => {
    it("collapses a utm_source spray into a single row", async () => {
      // 200 requests, each with a distinct random over-long utm_source.
      for (let i = 0; i < 200; i++) {
        await trackVisitorSource(
          d1,
          {
            path: "/en",
            referrer: null,
            params: new URLSearchParams(
              `utm_source=${"x".repeat(80)}${i}&utm_campaign=${"y".repeat(90)}${i}`,
            ),
            selfHost: SELF,
          },
          YES,
        );
      }
      const all = rows(sqlite);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        source: "other",
        campaign: "other",
        count: 200,
      });
    });

    it("bounds every stored dimension to the allowed charset and length", async () => {
      await trackVisitorSource(
        d1,
        {
          path: "/en",
          referrer: null,
          params: new URLSearchParams(
            "utm_source=Ω<script>&utm_medium=a b&utm_campaign=ok-campaign",
          ),
          selfHost: SELF,
        },
        YES,
      );
      const row = rows(sqlite)[0];
      for (const key of ["source", "medium", "campaign"]) {
        const v = row[key] as string;
        expect(v.length, key).toBeLessThanOrEqual(64);
        expect(v, key).toMatch(/^[a-z0-9._+-]+$/);
      }
      expect(row.campaign).toBe("ok-campaign");
    });
  });

  describe("read queries", () => {
    beforeEach(async () => {
      const seed: Array<{ ref: string | null; qs: string; path: string }> = [
        { ref: "https://www.google.com/", qs: "", path: "/en/blog/a" },
        { ref: "https://www.google.com/", qs: "", path: "/en/blog/a" },
        { ref: "https://t.co/x", qs: "", path: "/en/blog/b" },
        { ref: null, qs: "", path: "/en" },
        {
          ref: null,
          qs: "utm_source=newsletter&utm_medium=email&utm_campaign=launch",
          path: "/en/blog/a",
        },
        { ref: "https://example.com/en", qs: "", path: "/en/blog/b" },
      ];
      for (const s of seed) {
        await trackVisitorSource(
          d1,
          {
            path: s.path,
            referrer: s.ref,
            params: new URLSearchParams(s.qs),
            selfHost: SELF,
          },
          YES,
        );
      }
    });

    it("aggregates by channel", async () => {
      const svc = new AnalyticsService(d1);
      const byChannel = await svc.sourcesByChannel(30);
      const map = Object.fromEntries(
        byChannel.map((r) => [r.channel, r.total]),
      );
      expect(map).toMatchObject({
        organic_search: 2,
        social: 1,
        direct: 1,
        referral: 1,
        internal: 1,
      });
    });

    it("ranks top sources", async () => {
      const svc = new AnalyticsService(d1);
      const top = await svc.topSources(30, 10);
      expect(top[0]).toMatchObject({ source: "google", total: 2 });
    });

    it("lists only tagged campaigns", async () => {
      const svc = new AnalyticsService(d1);
      const campaigns = await svc.topCampaigns(30, 10);
      expect(campaigns).toHaveLength(1);
      expect(campaigns[0]).toMatchObject({
        campaign: "launch",
        source: "newsletter",
        medium: "email",
      });
    });

    it("excludes internal navigation from landing pages", async () => {
      const svc = new AnalyticsService(d1);
      const landings = await svc.topLandingPages(30, 10);
      const byPath = Object.fromEntries(landings.map((r) => [r.path, r.total]));
      // /en/blog/b got one social + one internal landing; only the
      // social one is an acquisition.
      expect(byPath["/en/blog/b"]).toBe(1);
      expect(byPath["/en/blog/a"]).toBe(3);
    });

    it("returns a 0-filled continuous series", async () => {
      const svc = new AnalyticsService(d1);
      const series = await svc.channelSeries(7);
      expect(series).toHaveLength(7);
      expect(series.at(-1)?.total).toBe(6);
      expect(series[0].total).toBe(0);
      expect(series[0].byChannel).toEqual({
        direct: 0,
        organic_search: 0,
        social: 0,
        referral: 0,
        internal: 0,
      });
    });
  });
});
