import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { refreshProductIndex, searchProducts } from "./search";

/**
 * Product search integration tests (#160 A3) against REAL SQLite,
 * replaying the real drizzle/*.sql chain — same harness as
 * src/lib/server/content/schema.integration.node.test.ts.
 *
 * What matters here and can only be proven against a real engine:
 *   - migration 0024 applies (trigram tokenizer is available — it
 *     needs SQLite >= 3.34, which both D1 and better-sqlite3 ship)
 *   - Thai substring queries actually match (the whole reason the
 *     table uses trigram instead of unicode61: Thai has no inter-word
 *     spaces for unicode61 to split on)
 *   - status filtering happens at QUERY time, so a draft->active flip
 *     needs no reindex
 *   - refreshProductIndex is idempotent delete+reinsert
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        db.exec(trimmed);
      } catch (err) {
        throw new Error(
          `Migration ${file} failed: ${(err as Error).message}\n\n${trimmed.slice(0, 300)}`,
          { cause: err },
        );
      }
    }
  }
}

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

function seedProduct(opts: {
  id: string;
  slug: string;
  status?: string;
  titleEn: string;
  titleTh?: string;
  prices?: Array<{ satang: number; status?: string }>;
}): void {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, 'n', 'n')`,
    )
    .run(opts.id, opts.slug, opts.status ?? "active");
  sqlite
    .prepare(
      `INSERT INTO shop_product_localizations (product_id, locale, title, description_markdown)
       VALUES (?, 'en', ?, 'Soft and breathable.')`,
    )
    .run(opts.id, opts.titleEn);
  if (opts.titleTh) {
    sqlite
      .prepare(
        `INSERT INTO shop_product_localizations (product_id, locale, title, description_markdown)
         VALUES (?, 'th', ?, NULL)`,
      )
      .run(opts.id, opts.titleTh);
  }
  for (const [i, v] of (opts.prices ?? []).entries()) {
    sqlite
      .prepare(
        `INSERT INTO shop_product_variants
           (id, product_id, status, title_cached, price_satang, position)
         VALUES (?, ?, ?, '', ?, ?)`,
      )
      .run(`${opts.id}-v${i}`, opts.id, v.status ?? "active", v.satang, i + 1);
  }
}

beforeAll(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  db = drizzle(sqlite);
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM shop_product_variants;
    DELETE FROM shop_product_localizations;
    DELETE FROM shop_products;
    DELETE FROM products_fts;`);
});

describe("migration 0024", () => {
  it("creates products_fts with the trigram tokenizer", () => {
    const row = sqlite
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='products_fts'`,
      )
      .get() as { sql: string } | undefined;
    expect(row?.sql).toMatch(/fts5/i);
    expect(row?.sql).toMatch(/trigram/);
  });

  it("backfills ALL statuses (status is filtered at query time)", () => {
    // Index-all policy: a status flip must not require a reindex, so
    // the migration's backfill SELECT must not filter on status.
    const migration = readFileSync(
      `${MIGRATIONS_DIR}/0024_products_fts.sql`,
      "utf8",
    );
    const backfill = migration.slice(migration.indexOf("INSERT INTO"));
    expect(backfill).not.toMatch(/status\s*=\s*'active'/);
  });
});

describe("refreshProductIndex", () => {
  it("indexes both locales of a product", async () => {
    seedProduct({
      id: "p1",
      slug: "blue-cotton-shirt",
      titleEn: "Blue Cotton Shirt",
      titleTh: "เสื้อเชิ้ตผ้าฝ้ายสีน้ำเงิน",
    });
    await refreshProductIndex(db, "p1");
    const n = sqlite
      .prepare(`SELECT COUNT(*) n FROM products_fts WHERE product_id='p1'`)
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("is idempotent — delete+reinsert, never accumulates", async () => {
    seedProduct({
      id: "p1",
      slug: "shirt",
      titleEn: "Shirt",
      titleTh: "เสื้อ",
    });
    await refreshProductIndex(db, "p1");
    await refreshProductIndex(db, "p1");
    await refreshProductIndex(db, "p1");
    const n = sqlite
      .prepare(`SELECT COUNT(*) n FROM products_fts WHERE product_id='p1'`)
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("picks up a title edit and drops the stale text", async () => {
    seedProduct({ id: "p1", slug: "shirt", titleEn: "Blue Cotton Shirt" });
    await refreshProductIndex(db, "p1");
    sqlite.exec(
      `UPDATE shop_product_localizations SET title='Green Linen Shirt'
       WHERE product_id='p1' AND locale='en'`,
    );
    await refreshProductIndex(db, "p1");
    const cotton = await searchProducts(db, { query: "cotton", locale: "en" });
    const linen = await searchProducts(db, { query: "linen", locale: "en" });
    expect(cotton).toHaveLength(0);
    expect(linen).toHaveLength(1);
  });

  it("clears the index rows after a product delete", async () => {
    seedProduct({ id: "p1", slug: "shirt", titleEn: "Shirt" });
    await refreshProductIndex(db, "p1");
    sqlite.exec(`DELETE FROM shop_products WHERE id='p1'`);
    await refreshProductIndex(db, "p1");
    const n = sqlite
      .prepare(`SELECT COUNT(*) n FROM products_fts WHERE product_id='p1'`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("searchProducts", () => {
  it("matches a Thai substring via trigram", async () => {
    // unicode61 would index the whole Thai title as ONE token and only
    // match the exact full string; trigram matches any >=3-char window.
    seedProduct({
      id: "p1",
      slug: "blue-cotton-shirt",
      titleEn: "Blue Cotton Shirt",
      titleTh: "เสื้อเชิ้ตผ้าฝ้ายสีน้ำเงิน",
      prices: [{ satang: 19900 }],
    });
    await refreshProductIndex(db, "p1");
    for (const q of ["เสื้อเชิ้ต", "ผ้าฝ้าย", "สีน้ำเงิน"]) {
      const hits = await searchProducts(db, { query: q, locale: "th" });
      expect(hits.map((h) => h.slug)).toEqual(["blue-cotton-shirt"]);
    }
  });

  it("matches an English prefix/substring", async () => {
    seedProduct({
      id: "p1",
      slug: "blue-cotton-shirt",
      titleEn: "Blue Cotton Shirt",
    });
    await refreshProductIndex(db, "p1");
    const hits = await searchProducts(db, { query: "cott", locale: "en" });
    expect(hits.map((h) => h.slug)).toEqual(["blue-cotton-shirt"]);
  });

  it("labels a cross-locale match with the requested locale's title", async () => {
    // A Thai query typed on the EN storefront still finds the product,
    // and the card shows the EN title.
    seedProduct({
      id: "p1",
      slug: "blue-cotton-shirt",
      titleEn: "Blue Cotton Shirt",
      titleTh: "เสื้อเชิ้ตผ้าฝ้าย",
    });
    await refreshProductIndex(db, "p1");
    const hits = await searchProducts(db, {
      query: "เสื้อเชิ้ต",
      locale: "en",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Blue Cotton Shirt");
  });

  it("filters status at query time — a flip needs no reindex", async () => {
    seedProduct({ id: "p1", slug: "shirt", titleEn: "Shirt", status: "draft" });
    await refreshProductIndex(db, "p1");

    expect(await searchProducts(db, { query: "shirt", locale: "en" })).toEqual(
      [],
    );

    // Flip to active WITHOUT touching the index.
    sqlite.exec(`UPDATE shop_products SET status='active' WHERE id='p1'`);
    const hits = await searchProducts(db, { query: "shirt", locale: "en" });
    expect(hits.map((h) => h.slug)).toEqual(["shirt"]);

    // And back to archived — disappears again, still no reindex.
    sqlite.exec(`UPDATE shop_products SET status='archived' WHERE id='p1'`);
    expect(await searchProducts(db, { query: "shirt", locale: "en" })).toEqual(
      [],
    );
  });

  it("returns the cheapest ACTIVE variant price", async () => {
    seedProduct({
      id: "p1",
      slug: "shirt",
      titleEn: "Shirt",
      prices: [
        { satang: 19900 },
        { satang: 9900 },
        { satang: 100, status: "archived" }, // must not win
      ],
    });
    await refreshProductIndex(db, "p1");
    const hits = await searchProducts(db, { query: "shirt", locale: "en" });
    expect(hits[0].priceFromSatang).toBe(9900);
  });

  it("rejects sub-minimum queries and serves 2-char via LIKE", async () => {
    seedProduct({ id: "p1", slug: "shirt", titleEn: "Blue Cotton Shirt" });
    await refreshProductIndex(db, "p1");

    // 1 char / empty: below MIN_QUERY_LENGTH, no search at all.
    expect(await searchProducts(db, { query: "B", locale: "en" })).toEqual([]);
    expect(await searchProducts(db, { query: "  ", locale: "en" })).toEqual([]);

    // 2 chars: below the trigram window, LIKE fallback over titles.
    const hits = await searchProducts(db, { query: "Bl", locale: "en" });
    expect(hits.map((h) => h.slug)).toEqual(["shirt"]);

    // LIKE wildcards are escaped — '%%' must not match everything.
    expect(await searchProducts(db, { query: "%%", locale: "en" })).toEqual([]);
  });

  it("survives unbalanced FTS punctuation", async () => {
    seedProduct({ id: "p1", slug: "shirt", titleEn: "Blue Cotton Shirt" });
    await refreshProductIndex(db, "p1");
    await expect(
      searchProducts(db, { query: 'shirt "(', locale: "en" }),
    ).resolves.toBeDefined();
  });

  it("caps and dedupes: one hit per product, limit respected", async () => {
    for (let i = 0; i < 10; i++) {
      seedProduct({
        id: `p${i}`,
        slug: `shirt-${i}`,
        titleEn: `Shirt ${i}`,
        titleTh: `เสื้อ ${i}`, // matches in BOTH locales — must not double
      });
      await refreshProductIndex(db, `p${i}`);
    }
    const hits = await searchProducts(db, {
      query: "shirt",
      locale: "en",
      limit: 8,
    });
    expect(hits).toHaveLength(8);
    expect(new Set(hits.map((h) => h.productId)).size).toBe(8);
  });
});

describe("source pins", () => {
  const read = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url).pathname, "utf8");

  it("search results page is noindex,follow", () => {
    // Google's guidance: block internal search results pages from the
    // index; `follow` keeps link equity flowing to the listed pages.
    const page = read("../../routes/(www)/[locale]/search/+page.server.ts");
    expect(page).toMatch(/noindex,follow/);
  });

  it("typeahead endpoint caps results at 8 and enforces min length", () => {
    const endpoint = read("../../routes/api/public/shop/search/+server.ts");
    expect(endpoint).toMatch(/RESULT_CAP = 8/);
    expect(endpoint).toMatch(/MIN_QUERY_LENGTH/);
    expect(endpoint).toMatch(/max-age=30/);
  });

  it("service write paths refresh the index (create + delete)", () => {
    const service = read("./service.ts");
    const create = service.slice(
      service.indexOf("async createProduct"),
      service.indexOf("async updateProductStatus"),
    );
    const del = service.slice(
      service.indexOf("async deleteProduct"),
      service.indexOf("// ── Inventory"),
    );
    expect(create).toMatch(/refreshProductIndex\(this\.db, productId\)/);
    expect(del).toMatch(/refreshProductIndex\(this\.db, id\)/);
  });
});
