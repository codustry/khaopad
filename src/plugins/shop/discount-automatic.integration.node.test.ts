import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDiscount,
  validateDiscount,
  evaluateAutomaticDiscounts,
  chooseBestDiscount,
  recordRedemption,
  type DiscountApplyOutcome,
} from "./discount-service";
import { computeTotals } from "./totals";

/**
 * D3 — automatic discounts against REAL SQLite with the REAL
 * migrations applied (same replay harness as the other shop
 * integration tests).
 *
 * Covers:
 *   - best-of arbitration picks the larger benefit, both directions
 *     (typed code beats automatic; automatic beats typed code), tie to
 *     the typed code;
 *   - windows and redemption caps apply to automatics identically;
 *   - redemption is recorded against the discount id with no typed
 *     code involved, and then counts against the caps;
 *   - the AUTO-* sentinel can never be redeemed by typing it in;
 *   - automatic free-shipping rides discountIsFreeShipping: zero
 *     allocation to goods lines (extends the v3.15 #108 regression);
 *   - checkout/start is actually wired to all of the above
 *     (source-level, matching the existing endpoint-glue tests).
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

/** Minimal D1Database shim over better-sqlite3, enough for Drizzle's d1 driver. */
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

const CTX = {
  subtotalSatang: 100_000, // ฿1,000 of goods
  shippingSatang: 5_000, // ฿50 shipping
  userId: null,
  userEmail: "buyer@example.com",
};

let sqlite: Database.Database;
let d1: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  d1 = d1Shim(sqlite);
});

describe("D3 — automatic discount evaluation", () => {
  it("returns null when no automatic discounts exist", async () => {
    await createDiscount(d1, {
      code: "SAVE10",
      kind: "percent",
      valuePercent: 10,
    });
    expect(await evaluateAutomaticDiscounts(d1, CTX)).toBeNull();
  });

  it("evaluates an active automatic and returns its amount", async () => {
    await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 10,
      description: "August sale",
    });
    const best = await evaluateAutomaticDiscounts(d1, CTX);
    expect(best?.amountSatang).toBe(10_000);
    expect(best?.discount.method).toBe("automatic");
    expect(best?.discount.code.startsWith("AUTO-")).toBe(true);
  });

  it("picks the automatic with the larger customer benefit", async () => {
    await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 5,
    });
    await createDiscount(d1, {
      method: "automatic",
      kind: "fixed_satang",
      valueSatang: 20_000,
    });
    const best = await evaluateAutomaticDiscounts(d1, CTX);
    expect(best?.amountSatang).toBe(20_000);
    expect(best?.discount.kind).toBe("fixed_satang");
  });

  it("respects the time window — not-started and expired automatics do not apply", async () => {
    await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 10,
      startsAt: "2999-01-01T00:00:00.000Z",
    });
    await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 20,
      endsAt: "2000-01-01T00:00:00.000Z",
    });
    expect(await evaluateAutomaticDiscounts(d1, CTX)).toBeNull();
  });

  it("respects the minimum-order floor", async () => {
    await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 10,
      minOrderSatang: 200_000,
    });
    expect(await evaluateAutomaticDiscounts(d1, CTX)).toBeNull();
    expect(
      await evaluateAutomaticDiscounts(d1, {
        ...CTX,
        subtotalSatang: 250_000,
      }),
    ).not.toBeNull();
  });

  it("the AUTO-* sentinel cannot be redeemed by typing it in", async () => {
    const id = await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 10,
    });
    const sentinel = sqlite
      .prepare(`SELECT code FROM shop_discount_codes WHERE id = ?`)
      .get(id) as { code: string };
    const outcome = await validateDiscount(d1, {
      code: sentinel.code,
      ...CTX,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("NOT_FOUND");
  });
});

describe("D3 — best-of arbitration (code vs automatic)", () => {
  async function outcomes(codePct: number, autoPct: number) {
    await createDiscount(d1, {
      code: "TYPED",
      kind: "percent",
      valuePercent: codePct,
    });
    await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: autoPct,
    });
    const codeOutcome = await validateDiscount(d1, { code: "TYPED", ...CTX });
    const autoOutcome = await evaluateAutomaticDiscounts(d1, CTX);
    return { codeOutcome, autoOutcome };
  }

  it("typed code wins when it is worth more", async () => {
    const { codeOutcome, autoOutcome } = await outcomes(20, 10);
    const chosen = chooseBestDiscount(codeOutcome, autoOutcome);
    expect(chosen?.amountSatang).toBe(20_000);
    expect(chosen?.discount.code).toBe("TYPED");
  });

  it("automatic wins when it is worth more", async () => {
    const { codeOutcome, autoOutcome } = await outcomes(10, 20);
    const chosen = chooseBestDiscount(codeOutcome, autoOutcome);
    expect(chosen?.amountSatang).toBe(20_000);
    expect(chosen?.discount.method).toBe("automatic");
  });

  it("tie goes to the typed code (the customer expects THAT code on the receipt)", async () => {
    const { codeOutcome, autoOutcome } = await outcomes(15, 15);
    const chosen = chooseBestDiscount(codeOutcome, autoOutcome);
    expect(chosen?.discount.code).toBe("TYPED");
  });

  it("automatic applies even when the typed code is invalid", async () => {
    await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 10,
    });
    const codeOutcome: DiscountApplyOutcome = await validateDiscount(d1, {
      code: "NO-SUCH-CODE",
      ...CTX,
    });
    const autoOutcome = await evaluateAutomaticDiscounts(d1, CTX);
    const chosen = chooseBestDiscount(codeOutcome, autoOutcome);
    expect(chosen?.amountSatang).toBe(10_000);
  });

  it("no discount at all when neither applies", () => {
    expect(chooseBestDiscount(null, null)).toBeNull();
  });
});

describe("D3 — redemption recording without a typed code", () => {
  it("records against the discount id and then counts toward maxRedemptions", async () => {
    const id = await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 10,
      maxRedemptions: 1,
    });
    await recordRedemption(d1, {
      discountId: id,
      orderId: "order-1",
      userEmail: "buyer@example.com",
      amountSatang: 10_000,
    });
    const row = sqlite
      .prepare(
        `SELECT discount_id, order_id, amount_satang
           FROM shop_discount_redemptions WHERE discount_id = ?`,
      )
      .get(id) as { discount_id: string; order_id: string };
    expect(row.order_id).toBe("order-1");

    // The global cap is now hit — the automatic stops applying.
    expect(await evaluateAutomaticDiscounts(d1, CTX)).toBeNull();
  });

  it("per-customer cap on an automatic blocks only that customer", async () => {
    const id = await createDiscount(d1, {
      method: "automatic",
      kind: "percent",
      valuePercent: 10,
      maxPerCustomer: 1,
    });
    await recordRedemption(d1, {
      discountId: id,
      orderId: "order-1",
      userEmail: "buyer@example.com",
      amountSatang: 10_000,
    });
    expect(await evaluateAutomaticDiscounts(d1, CTX)).toBeNull();
    expect(
      await evaluateAutomaticDiscounts(d1, {
        ...CTX,
        userEmail: "other@example.com",
      }),
    ).not.toBeNull();
  });
});

describe("D3 — automatic free-shipping (extends the v3.15 #108 regression)", () => {
  it("discounts exactly the shipping line and allocates ZERO to goods", async () => {
    await createDiscount(d1, {
      method: "automatic",
      kind: "free_shipping",
    });
    const best = await evaluateAutomaticDiscounts(d1, CTX);
    expect(best?.freeShipping).toBe(true);
    expect(best?.amountSatang).toBe(CTX.shippingSatang);

    // Feed the outcome through the totals engine exactly as
    // checkout/start does — no satang of the shipping discount may
    // land on a goods line (#108: it would under-refund returns).
    const totals = computeTotals({
      lines: [
        { id: "a", amountSatang: 60_000 },
        { id: "b", amountSatang: 40_000 },
      ],
      shippingSatang: CTX.shippingSatang,
      discountSatang: best?.amountSatang ?? 0,
      discountIsFreeShipping: best?.freeShipping ?? false,
      tax: { enabled: true, ratePct: 7, pricesIncludeTax: true },
    });
    expect(totals.discountSatang).toBe(CTX.shippingSatang);
    expect(totals.totalSatang).toBe(100_000); // goods stay full price
    for (const a of totals.allocations) {
      expect(a.discountAllocatedSatang).toBe(0);
    }
  });
});

describe("checkout/start endpoint glue (source-level, D3/D5)", () => {
  const src = readFileSync(
    new URL("../../routes/api/shop/checkout/start/+server.ts", import.meta.url)
      .pathname,
    "utf8",
  );

  it("evaluates automatic discounts and arbitrates via chooseBestDiscount", () => {
    expect(src).toContain("evaluateAutomaticDiscounts(");
    expect(src).toContain("chooseBestDiscount(");
  });

  it("persists the D5 tax fields and the free-shipping flag on the order", () => {
    expect(src).toContain("taxIncludedSatang: totals.taxIncludedSatang");
    expect(src).toMatch(/taxMode:.*"inclusive".*"exclusive"/s);
    expect(src).toContain("discountIsFreeShipping,");
  });
});
