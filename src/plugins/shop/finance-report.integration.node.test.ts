import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildFinanceReport,
  financeReportToCsv,
  resolveReportRange,
} from "./finance-report";

/**
 * D5 — finance report aggregates against REAL SQLite with the REAL
 * migrations (0028 adds tax_included_satang + tax_mode).
 *
 * The seeded ledger is exact and every assertion checks the exact
 * satang, both tax modes:
 *
 *   day 2026-08-01
 *     A  paid,      exclusive: subtotal 100_000 + shipping 5_000,
 *        discount 10_000, tax 6_650 (7% of 95_000), total 101_650
 *     B  paid,      inclusive: subtotal 214_000 + shipping 0,
 *        discount 0, tax_included 14_000 (7/107 of 214_000), total 214_000
 *     P  pending    (must NOT count)
 *     C  cancelled  (must NOT count)
 *   day 2026-08-02
 *     D  refunded,  inclusive: subtotal 50_000, no discount,
 *        tax_included 3_271, total 50_000
 *        + full-refund ledger row of 50_000 dated 2026-08-03
 *        + a manual_credit adjustment (must NOT count as a refund)
 *
 * Expected in-range (Aug 1–31) totals:
 *   orders    = 3            (A, B, D)
 *   gross     = 105_000 + 214_000 + 50_000 = 369_000
 *   discounts = 10_000
 *   net       = 359_000
 *   VAT excl  = 6_650        (A only)
 *   VAT incl  = 17_271       (B 14_000 + D 3_271)
 *   refunds   = 50_000       (on 2026-08-03, the ledger row's day)
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

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

/** Minimal D1Database shim over better-sqlite3 (raw prepared statements only). */
function d1Shim(db: Database.Database): D1Database {
  const run = (sql: string, params: unknown[]) => {
    const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const bound =
      numbered.length > 0 ? numbered.map((n) => params[n - 1]) : params;
    const stmt = db.prepare(sql.replace(/\?\d+/g, "?"));
    if (/^\s*(select|pragma)/i.test(sql) || /returning/i.test(sql)) {
      const results = stmt.all(...bound);
      return { results, success: true, meta: {} };
    }
    const info = stmt.run(...bound);
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

function seedOrder(
  db: Database.Database,
  id: string,
  opts: {
    createdAt: string;
    financialStatus: string;
    subtotal: number;
    shipping?: number;
    discount?: number;
    tax?: number;
    taxIncluded?: number;
    taxMode?: "exclusive" | "inclusive";
    total: number;
  },
) {
  db.prepare(
    `INSERT INTO shop_orders
       (id, order_number, email, status, financial_status,
        subtotal_satang, shipping_satang, tax_satang, tax_included_satang,
        tax_mode, discount_satang, total_satang, created_at, updated_at)
     VALUES (?, ?, 'buyer@example.com', 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `KHP-2026-${id}`,
    opts.financialStatus,
    opts.subtotal,
    opts.shipping ?? 0,
    opts.tax ?? 0,
    opts.taxIncluded ?? 0,
    opts.taxMode ?? "exclusive",
    opts.discount ?? 0,
    opts.total,
    opts.createdAt,
    opts.createdAt,
  );
}

function seedAdjustment(
  db: Database.Database,
  id: string,
  opts: { orderId: string; kind: string; amount: number; createdAt: string },
) {
  db.prepare(
    `INSERT INTO shop_order_adjustments
       (id, order_id, kind, amount_satang, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.orderId, opts.kind, opts.amount, opts.createdAt);
}

let sqlite: Database.Database;
let d1: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  d1 = d1Shim(sqlite);

  seedOrder(sqlite, "A", {
    createdAt: "2026-08-01T09:00:00.000Z",
    financialStatus: "paid",
    subtotal: 100_000,
    shipping: 5_000,
    discount: 10_000,
    tax: 6_650,
    taxMode: "exclusive",
    total: 101_650,
  });
  seedOrder(sqlite, "B", {
    createdAt: "2026-08-01T12:00:00.000Z",
    financialStatus: "paid",
    subtotal: 214_000,
    taxIncluded: 14_000,
    taxMode: "inclusive",
    total: 214_000,
  });
  seedOrder(sqlite, "P", {
    createdAt: "2026-08-01T13:00:00.000Z",
    financialStatus: "pending",
    subtotal: 999_999,
    total: 999_999,
  });
  seedOrder(sqlite, "C", {
    createdAt: "2026-08-01T14:00:00.000Z",
    financialStatus: "cancelled",
    subtotal: 888_888,
    total: 888_888,
  });
  seedOrder(sqlite, "D", {
    createdAt: "2026-08-02T10:00:00.000Z",
    financialStatus: "refunded",
    subtotal: 50_000,
    taxIncluded: 3_271,
    taxMode: "inclusive",
    total: 50_000,
  });
  seedAdjustment(sqlite, "adj-1", {
    orderId: "D",
    kind: "refund_full",
    amount: -50_000,
    createdAt: "2026-08-03T08:00:00.000Z",
  });
  // Non-refund adjustment — must never count toward the refund column.
  seedAdjustment(sqlite, "adj-2", {
    orderId: "A",
    kind: "manual_credit",
    amount: -1_000,
    createdAt: "2026-08-03T09:00:00.000Z",
  });
});

describe("D5 — finance report aggregates", () => {
  it("matches the seeded ledger exactly (both tax modes)", async () => {
    const report = await buildFinanceReport(d1, {
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(report.totals).toEqual({
      orders: 3,
      grossSatang: 369_000,
      discountSatang: 10_000,
      netSatang: 359_000,
      vatExclusiveSatang: 6_650,
      vatIncludedSatang: 17_271,
      refundSatang: 50_000,
    });
  });

  it("breaks down by day, refunds on the day they were recorded", async () => {
    const report = await buildFinanceReport(d1, {
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(report.days.map((r) => r.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    const [d1st, d2nd, d3rd] = report.days;
    expect(d1st).toEqual({
      date: "2026-08-01",
      orders: 2,
      grossSatang: 319_000,
      discountSatang: 10_000,
      netSatang: 309_000,
      vatExclusiveSatang: 6_650,
      vatIncludedSatang: 14_000,
      refundSatang: 0,
    });
    expect(d2nd).toEqual({
      date: "2026-08-02",
      orders: 1,
      grossSatang: 50_000,
      discountSatang: 0,
      netSatang: 50_000,
      vatExclusiveSatang: 0,
      vatIncludedSatang: 3_271,
      refundSatang: 0,
    });
    // The refund day has no orders — it appears for the money movement.
    expect(d3rd).toEqual({
      date: "2026-08-03",
      orders: 0,
      grossSatang: 0,
      discountSatang: 0,
      netSatang: 0,
      vatExclusiveSatang: 0,
      vatIncludedSatang: 0,
      refundSatang: 50_000,
    });
  });

  it("range bounds are inclusive and clip both orders and refunds", async () => {
    const report = await buildFinanceReport(d1, {
      from: "2026-08-02",
      to: "2026-08-02",
    });
    expect(report.totals.orders).toBe(1);
    expect(report.totals.grossSatang).toBe(50_000);
    expect(report.totals.refundSatang).toBe(0); // refund landed on the 3rd
  });

  it("empty range aggregates to zeros", async () => {
    const report = await buildFinanceReport(d1, {
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.days).toEqual([]);
    expect(report.totals.orders).toBe(0);
    expect(report.totals.grossSatang).toBe(0);
  });
});

describe("D5 — CSV export", () => {
  it("emits header, one row per day, and a TOTAL row, all integer satang", async () => {
    const report = await buildFinanceReport(d1, {
      from: "2026-08-01",
      to: "2026-08-31",
    });
    const csv = financeReportToCsv(report);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "date,orders,gross_satang,discounts_satang,net_satang,vat_exclusive_satang,vat_included_satang,refunds_satang",
    );
    expect(lines).toHaveLength(1 + 3 + 1); // header + 3 days + TOTAL
    expect(lines[1]).toBe("2026-08-01,2,319000,10000,309000,6650,14000,0");
    expect(lines[2]).toBe("2026-08-02,1,50000,0,50000,0,3271,0");
    expect(lines[3]).toBe("2026-08-03,0,0,0,0,0,0,50000");
    expect(lines[4]).toBe("TOTAL,3,369000,10000,359000,6650,17271,50000");
  });
});

describe("D5 — range resolution", () => {
  it("defaults to the current month (UTC)", () => {
    const range = resolveReportRange(
      null,
      null,
      new Date("2026-08-12T10:00:00.000Z"),
    );
    expect(range).toEqual({ from: "2026-08-01", to: "2026-08-12" });
  });

  it("accepts explicit bounds and rejects malformed ones", () => {
    expect(
      resolveReportRange("2026-01-05", "2026-02-05", new Date("2026-08-12")),
    ).toEqual({ from: "2026-01-05", to: "2026-02-05" });
    const fallback = resolveReportRange(
      "junk",
      "also-junk",
      new Date("2026-08-12T10:00:00.000Z"),
    );
    expect(fallback).toEqual({ from: "2026-08-01", to: "2026-08-12" });
  });

  it("normalizes a reversed range", () => {
    expect(
      resolveReportRange("2026-03-01", "2026-02-01", new Date("2026-08-12")),
    ).toEqual({ from: "2026-02-01", to: "2026-03-01" });
  });
});
