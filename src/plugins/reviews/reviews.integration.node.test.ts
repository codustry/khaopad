import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ReviewService, validateReviewPayload } from "./service";

/**
 * #160 (Phase D, D2) — reviews integration harness: REAL SQLite with
 * the REAL migrations (same shim as the shop totals harness), pinning:
 *
 *   - verified-purchase matching (paid order + product match → 1;
 *     wrong email / unpaid / different product → 0)
 *   - moderation status flow (pending → approved/rejected) and that
 *     the storefront query + aggregate see APPROVED reviews only
 *   - the per-IP rate-limit window count
 *   - payload validation shared by /api/reviews
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/** Minimal D1Database shim over better-sqlite3 (same as shop harnesses). */
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

let sqlite: Database.Database;
let svc: ReviewService;

const NOW = "2026-08-12T10:00:00.000Z";

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
  svc = new ReviewService(d1Shim(sqlite));
});

// ─── Seed helpers ───────────────────────────────────────────

function seedProduct(id: string) {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(id, id, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO shop_product_variants
         (id, product_id, status, title_cached, price_satang)
       VALUES (?, ?, 'active', 'Default', 10000)`,
    )
    .run(`var-${id}`, id);
}

function seedOrder(opts: {
  id: string;
  orderNumber: string;
  email: string;
  paid: boolean;
  variantIds: string[];
}) {
  sqlite
    .prepare(
      `INSERT INTO shop_orders
         (id, order_number, email, status, financial_status,
          subtotal_satang, total_satang, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, 'paid', ?, 10000, 10000, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.orderNumber,
      opts.email,
      opts.paid ? "paid" : "pending",
      opts.paid ? NOW : null,
      NOW,
      NOW,
    );
  for (const [i, variantId] of opts.variantIds.entries()) {
    sqlite
      .prepare(
        `INSERT INTO shop_order_items
           (id, order_id, variant_id, quantity, title_snapshot,
            price_snapshot_satang, line_subtotal_satang)
         VALUES (?, ?, ?, 1, 'Default', 10000, 10000)`,
      )
      .run(`${opts.id}-item-${i}`, opts.id, variantId);
  }
}

const BASE = {
  productId: "prod-a",
  email: "buyer@example.com",
  rating: 4,
  title: "Great",
  body: "Really solid product.",
};

// ─── Verified purchase ──────────────────────────────────────

describe("verified-purchase matching", () => {
  beforeEach(() => {
    seedProduct("prod-a");
    seedProduct("prod-b");
    seedOrder({
      id: "ord-1",
      orderNumber: "KP-1001",
      email: "buyer@example.com",
      paid: true,
      variantIds: ["var-prod-a"],
    });
  });

  it("marks verified when a paid order with matching email contains the product", async () => {
    const review = await svc.createReview({ ...BASE, orderNumber: "KP-1001" });
    expect(review.verified).toBe(1);
    expect(review.orderId).toBe("ord-1");
  });

  it("does not verify with the wrong email", async () => {
    const review = await svc.createReview({
      ...BASE,
      email: "attacker@example.com",
      orderNumber: "KP-1001",
    });
    expect(review.verified).toBe(0);
    expect(review.orderId).toBeNull();
  });

  it("does not verify an unpaid order", async () => {
    seedOrder({
      id: "ord-2",
      orderNumber: "KP-1002",
      email: "buyer@example.com",
      paid: false,
      variantIds: ["var-prod-a"],
    });
    const review = await svc.createReview({ ...BASE, orderNumber: "KP-1002" });
    expect(review.verified).toBe(0);
  });

  it("does not verify when the order never contained the product", async () => {
    const review = await svc.createReview({
      ...BASE,
      productId: "prod-b",
      orderNumber: "KP-1001",
    });
    expect(review.verified).toBe(0);
  });

  it("does not verify with no order number at all", async () => {
    const review = await svc.createReview(BASE);
    expect(review.verified).toBe(0);
    expect(review.orderId).toBeNull();
  });
});

// ─── Moderation flow + storefront visibility ────────────────

describe("moderation status flow", () => {
  beforeEach(() => seedProduct("prod-a"));

  it("new reviews start pending and are invisible to the storefront", async () => {
    const review = await svc.createReview(BASE);
    expect(review.status).toBe("pending");
    expect(await svc.listApproved("prod-a")).toEqual([]);
    expect(await svc.getAggregate("prod-a")).toEqual({
      average: null,
      count: 0,
    });
  });

  it("approve makes the review public; reject hides it again", async () => {
    const review = await svc.createReview(BASE);

    const approved = await svc.setStatus(review.id, "approved");
    expect(approved?.status).toBe("approved");
    expect((await svc.listApproved("prod-a")).map((r) => r.id)).toEqual([
      review.id,
    ]);

    const rejected = await svc.setStatus(review.id, "rejected");
    expect(rejected?.status).toBe("rejected");
    expect(await svc.listApproved("prod-a")).toEqual([]);
  });

  it("aggregate averages APPROVED reviews only", async () => {
    const r1 = await svc.createReview({ ...BASE, rating: 5 });
    const r2 = await svc.createReview({ ...BASE, rating: 4 });
    // A pending 1-star must not drag the average down.
    await svc.createReview({ ...BASE, rating: 1 });
    await svc.setStatus(r1.id, "approved");
    await svc.setStatus(r2.id, "approved");

    expect(await svc.getAggregate("prod-a")).toEqual({
      average: 4.5,
      count: 2,
    });
  });

  it("counts the moderation queue by status", async () => {
    const r1 = await svc.createReview(BASE);
    await svc.createReview(BASE);
    await svc.setStatus(r1.id, "approved");
    expect(await svc.countByStatus("pending")).toBe(1);
    expect(await svc.countByStatus("approved")).toBe(1);
  });
});

// ─── Rate limit window ──────────────────────────────────────

describe("per-IP rate limit count", () => {
  beforeEach(() => seedProduct("prod-a"));

  it("counts only recent submissions from the same ip hash", async () => {
    await svc.createReview({ ...BASE, ipHash: "aaaa" });
    await svc.createReview({ ...BASE, ipHash: "aaaa" });
    await svc.createReview({ ...BASE, ipHash: "bbbb" });
    // Backdate one aaaa submission beyond the window.
    sqlite
      .prepare(
        `UPDATE product_reviews SET created_at = '2000-01-01T00:00:00.000Z'
         WHERE rowid = (SELECT rowid FROM product_reviews WHERE ip_hash='aaaa' LIMIT 1)`,
      )
      .run();
    expect(await svc.countRecentByIp("aaaa", 60)).toBe(1);
    expect(await svc.countRecentByIp("bbbb", 60)).toBe(1);
    expect(await svc.countRecentByIp("cccc", 60)).toBe(0);
  });
});

// ─── Shared payload validation (used by /api/reviews) ───────

describe("validateReviewPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(validateReviewPayload(BASE)).toEqual({ ok: true });
  });

  it.each([
    [{ ...BASE, rating: 0 }],
    [{ ...BASE, rating: 6 }],
    [{ ...BASE, rating: 3.5 }],
    [{ ...BASE, rating: Number.NaN }],
  ])("rejects out-of-range or fractional ratings %#", (payload) => {
    expect(validateReviewPayload(payload).ok).toBe(false);
  });

  it("rejects bad emails, empty titles and empty bodies", () => {
    expect(validateReviewPayload({ ...BASE, email: "nope" }).ok).toBe(false);
    expect(validateReviewPayload({ ...BASE, title: "  " }).ok).toBe(false);
    expect(validateReviewPayload({ ...BASE, body: "" }).ok).toBe(false);
  });

  it("rejects oversized titles and bodies", () => {
    expect(validateReviewPayload({ ...BASE, title: "x".repeat(151) }).ok).toBe(
      false,
    );
    expect(validateReviewPayload({ ...BASE, body: "x".repeat(4001) }).ok).toBe(
      false,
    );
  });
});
