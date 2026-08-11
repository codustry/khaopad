import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { relatedProducts } from "./related";

/**
 * #160 A5 — relatedProducts() against REAL SQLite with the REAL
 * migrations applied (same harness as
 * checkout-start.integration.node.test.ts).
 *
 * The shim additionally ENFORCES D1's 100-bound-parameter ceiling:
 * better-sqlite3 happily binds 999+ params, so without the guard a
 * missing chunk would pass here and 500 in production.
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/** D1 binds at most 100 parameters per statement. */
const D1_MAX_BIND_PARAMS = 100;

/** Minimal D1Database shim over better-sqlite3, enough for Drizzle's d1 driver. */
function d1Shim(db: Database.Database): D1Database {
  const run = (sql: string, params: unknown[]) => {
    if (params.length > D1_MAX_BIND_PARAMS) {
      throw new Error(
        `D1_ERROR: too many SQL variables (${params.length} > ${D1_MAX_BIND_PARAMS})`,
      );
    }
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
let d1: D1Database;

const NOW = "2026-08-10T10:00:00.000Z";

function seedProduct(
  id: string,
  opts: {
    status?: string;
    productType?: string | null;
    vendor?: string | null;
    title?: string;
  } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, product_type, vendor, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      id,
      opts.status ?? "active",
      opts.productType ?? null,
      opts.vendor ?? null,
      NOW,
      NOW,
    );
  sqlite
    .prepare(
      `INSERT INTO shop_product_localizations (product_id, locale, title)
       VALUES (?, 'en', ?)`,
    )
    .run(id, opts.title ?? `Title of ${id}`);
  sqlite
    .prepare(
      `INSERT INTO shop_product_variants
         (id, product_id, status, title_cached, price_satang)
       VALUES (?, ?, 'active', 'Default', 10000)`,
    )
    .run(`var-${id}`, id);
}

/** One paid order containing one line per given product's default variant. */
let orderSeq = 0;
function seedOrder(productIds: string[]) {
  const orderId = `ord-${orderSeq++}`;
  sqlite
    .prepare(
      `INSERT INTO shop_orders
         (id, order_number, email, status, subtotal_satang, total_satang, created_at, updated_at)
       VALUES (?, ?, 'x@example.com', 'paid', 10000, 10000, ?, ?)`,
    )
    .run(orderId, `KHP-${orderId}`, NOW, NOW);
  for (const pid of productIds) {
    sqlite
      .prepare(
        `INSERT INTO shop_order_items
           (id, order_id, variant_id, quantity, title_snapshot, price_snapshot_satang, line_subtotal_satang)
         VALUES (?, ?, ?, 1, 'snap', 10000, 10000)`,
      )
      .run(`oi-${orderId}-${pid}`, orderId, `var-${pid}`);
  }
}

function seedCollection(id: string, productIds: string[]) {
  sqlite
    .prepare(
      `INSERT INTO shop_collections (id, slug, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(id, id, NOW, NOW);
  productIds.forEach((pid, i) => {
    sqlite
      .prepare(
        `INSERT INTO shop_collection_products (collection_id, product_id, position)
         VALUES (?, ?, ?)`,
      )
      .run(id, pid, i);
  });
}

function seedOptionValue(productId: string, name: string, value: string) {
  const optId = `opt-${productId}-${name}`;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO shop_product_options (id, product_id, name, position)
       VALUES (?, ?, ?, 1)`,
    )
    .run(optId, productId, name);
  sqlite
    .prepare(
      `INSERT INTO shop_product_option_values (id, option_id, value)
       VALUES (?, ?, ?)`,
    )
    .run(`ov-${productId}-${name}-${value}`, optId, value);
}

beforeEach(() => {
  orderSeq = 0;
  sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  d1 = d1Shim(sqlite);
});

describe("relatedProducts — signal ranking", () => {
  it("ranks order co-occurrence above same-collection, weighted by count", async () => {
    seedProduct("self");
    seedProduct("co-strong"); // co-occurs in 2 orders
    seedProduct("co-weak"); // co-occurs in 1 order
    seedProduct("coll-only"); // shares a collection, never an order
    seedOrder(["self", "co-strong"]);
    seedOrder(["self", "co-strong", "co-weak"]);
    seedCollection("c1", ["coll-only", "self"]);

    const out = await relatedProducts(d1, { productId: "self" });
    expect(out.map((p) => p.id)).toEqual(["co-strong", "co-weak", "coll-only"]);
  });

  it("same-collection fills in curated position order after co-occurrence", async () => {
    seedProduct("self");
    seedProduct("co");
    seedProduct("pos-2");
    seedProduct("pos-0");
    seedOrder(["self", "co"]);
    // Positions: pos-0 before self before pos-2.
    seedCollection("c1", ["pos-0", "self", "pos-2"]);

    const out = await relatedProducts(d1, { productId: "self" });
    expect(out.map((p) => p.id)).toEqual(["co", "pos-0", "pos-2"]);
  });

  it("catalog-affinity fallback: product_type outranks vendor outranks shared option values", async () => {
    // No orders, no collections — only the third signal fires.
    seedProduct("self", { productType: "pump", vendor: "acme" });
    seedProduct("by-option");
    seedProduct("by-vendor", { productType: "blower", vendor: "acme" });
    seedProduct("by-type", { productType: "pump", vendor: "other" });
    seedProduct("unrelated");
    seedOptionValue("self", "Size", "M");
    seedOptionValue("by-option", "Size", "M");
    seedOptionValue("unrelated", "Size", "XXL");

    const out = await relatedProducts(d1, { productId: "self" });
    expect(out.map((p) => p.id)).toEqual(["by-type", "by-vendor", "by-option"]);
  });
});

describe("relatedProducts — exclusions and limits", () => {
  it("excludes the product itself and non-active products", async () => {
    seedProduct("self");
    seedProduct("active-sibling");
    seedProduct("draft-sibling", { status: "draft" });
    seedProduct("archived-sibling", { status: "archived" });
    seedCollection("c1", [
      "self",
      "active-sibling",
      "draft-sibling",
      "archived-sibling",
    ]);
    // Non-active products excluded even when they co-occur in orders.
    seedOrder(["self", "draft-sibling"]);

    const out = await relatedProducts(d1, { productId: "self" });
    expect(out.map((p) => p.id)).toEqual(["active-sibling"]);
  });

  it("respects the limit", async () => {
    seedProduct("self");
    for (let i = 0; i < 10; i++) seedProduct(`p-${i}`);
    seedCollection("c1", [
      "self",
      ...Array.from({ length: 10 }, (_, i) => `p-${i}`),
    ]);

    const out = await relatedProducts(d1, { productId: "self", limit: 3 });
    expect(out).toHaveLength(3);
    const dflt = await relatedProducts(d1, { productId: "self" });
    expect(dflt).toHaveLength(8);
  });

  it("returns [] for an unknown product and for a catalog of one", async () => {
    seedProduct("self");
    expect(await relatedProducts(d1, { productId: "self" })).toEqual([]);
    expect(await relatedProducts(d1, { productId: "ghost" })).toEqual([]);
  });

  it("hydrates title, price-from, slug and media for the strip", async () => {
    seedProduct("self");
    seedProduct("other", { title: "Other Thing" });
    // A cheaper second active variant — price-from must pick it up.
    sqlite
      .prepare(
        `INSERT INTO shop_product_variants (id, product_id, status, title_cached, price_satang)
         VALUES ('var-other-2', 'other', 'active', 'Small', 5000)`,
      )
      .run();
    seedCollection("c1", ["self", "other"]);

    const out = await relatedProducts(d1, { productId: "self" });
    expect(out).toEqual([
      {
        id: "other",
        slug: "other",
        featuredMediaId: null,
        priceFromSatang: 5000,
        titles: { en: "Other Thing" },
      },
    ]);
  });
});

describe("relatedProducts — D1 bind-parameter safety", () => {
  it("survives 100+ orders and 100+ candidates without exceeding 100 binds per statement", async () => {
    // The shim throws on >100 bound params (see d1Shim), so this test
    // fails loudly if any inArray load loses its chunking.
    seedProduct("self", { vendor: "acme" });
    // 110 orders → the order-id list must be chunked.
    const partners: string[] = [];
    for (let i = 0; i < 55; i++) {
      const id = `co-${String(i).padStart(3, "0")}`;
      partners.push(id);
      seedProduct(id);
      seedOrder(["self", id]);
      seedOrder(["self", id]);
    }
    // 60 more via a collection, 40 more via vendor affinity — the
    // merged candidate list (~140 ids) must be chunked when hydrated.
    const collProducts: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `coll-${String(i).padStart(3, "0")}`;
      collProducts.push(id);
      seedProduct(id);
    }
    seedCollection("big", ["self", ...collProducts]);
    for (let i = 0; i < 40; i++) {
      seedProduct(`vend-${String(i).padStart(3, "0")}`, { vendor: "acme" });
    }

    const out = await relatedProducts(d1, { productId: "self", limit: 8 });
    expect(out).toHaveLength(8);
    // Strongest signal still wins: all 8 are co-occurrence hits.
    for (const p of out) {
      expect(partners).toContain(p.id);
    }
  });
});
