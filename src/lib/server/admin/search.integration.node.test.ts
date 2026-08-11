import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { refreshProductIndex } from "$plugins/shop/search";
import { searchAdminOrders, searchAdminProducts } from "./search";

/**
 * ⌘K admin search (#160 C7) against REAL SQLite, replaying the real
 * drizzle/*.sql migration chain — same harness as
 * src/plugins/shop/search.node.test.ts.
 *
 * Pins, per the endpoint contract:
 *   - orders match by order-number and email PREFIX, capped
 *   - order hits carry exactly {id, orderNumber, email, status} — the
 *     buyer email is the only PII that may leave the server
 *   - products match via products_fts across ALL statuses (the admin
 *     is often looking for a draft), and by slug
 */
const MIGRATIONS_DIR = new URL("../../../../drizzle", import.meta.url).pathname;

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

function seedOrder(opts: {
  id: string;
  orderNumber: string;
  email: string;
  createdAt?: string;
  status?: string;
}): void {
  sqlite
    .prepare(
      `INSERT INTO shop_orders
         (id, order_number, email, status, subtotal_satang, total_satang,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 10000, 10000, ?, ?)`,
    )
    .run(
      opts.id,
      opts.orderNumber,
      opts.email,
      opts.status ?? "paid",
      opts.createdAt ?? "2026-01-01T00:00:00Z",
      opts.createdAt ?? "2026-01-01T00:00:00Z",
    );
}

async function seedProduct(opts: {
  id: string;
  slug: string;
  status?: string;
  titleEn: string;
}): Promise<void> {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, 'n', 'n')`,
    )
    .run(opts.id, opts.slug, opts.status ?? "active");
  sqlite
    .prepare(
      `INSERT INTO shop_product_localizations (product_id, locale, title, description_markdown)
       VALUES (?, 'en', ?, 'Desc.')`,
    )
    .run(opts.id, opts.titleEn);
  await refreshProductIndex(db, opts.id);
}

beforeAll(() => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  db = drizzle(sqlite);
});

beforeEach(() => {
  sqlite.exec(
    "DELETE FROM shop_orders; DELETE FROM products_fts; DELETE FROM shop_product_localizations; DELETE FROM shop_products;",
  );
});

describe("searchAdminOrders", () => {
  it("matches by order-number prefix, newest first", async () => {
    seedOrder({
      id: "o1",
      orderNumber: "KHP-2026-00001",
      email: "a@example.com",
      createdAt: "2026-01-01T00:00:00Z",
    });
    seedOrder({
      id: "o2",
      orderNumber: "KHP-2026-00002",
      email: "b@example.com",
      createdAt: "2026-02-01T00:00:00Z",
    });
    seedOrder({
      id: "o3",
      orderNumber: "XYZ-1",
      email: "c@example.com",
    });
    const hits = await searchAdminOrders(db, "KHP-2026");
    expect(hits.map((h) => h.id)).toEqual(["o2", "o1"]);
  });

  it("matches by email prefix but NOT by substring", async () => {
    seedOrder({ id: "o1", orderNumber: "KHP-1", email: "somchai@example.com" });
    expect(await searchAdminOrders(db, "somch")).toHaveLength(1);
    // Substring of the domain must not match — prefix only.
    expect(await searchAdminOrders(db, "example.com")).toHaveLength(0);
  });

  it("caps results at the requested limit", async () => {
    for (let i = 0; i < 8; i++) {
      seedOrder({
        id: `o${i}`,
        orderNumber: `KHP-${i}`,
        email: `x${i}@example.com`,
      });
    }
    expect(await searchAdminOrders(db, "KHP", 5)).toHaveLength(5);
  });

  it("returns no field beyond {id, orderNumber, email, status} — PII pin", async () => {
    seedOrder({ id: "o1", orderNumber: "KHP-1", email: "pii@example.com" });
    const [hit] = await searchAdminOrders(db, "KHP");
    expect(Object.keys(hit).sort()).toEqual([
      "email",
      "id",
      "orderNumber",
      "status",
    ]);
  });

  it("escapes LIKE wildcards — % cannot widen the match", async () => {
    seedOrder({ id: "o1", orderNumber: "KHP-1", email: "a@example.com" });
    expect(await searchAdminOrders(db, "%%")).toHaveLength(0);
  });

  it("returns nothing below the minimum query length", async () => {
    seedOrder({ id: "o1", orderNumber: "K1", email: "a@example.com" });
    expect(await searchAdminOrders(db, "K")).toHaveLength(0);
  });
});

describe("searchAdminProducts", () => {
  it("finds products via products_fts by title", async () => {
    await seedProduct({ id: "p1", slug: "cotton-tee", titleEn: "Cotton tee" });
    await seedProduct({ id: "p2", slug: "wool-sock", titleEn: "Wool sock" });
    const hits = await searchAdminProducts(db, "cotton");
    expect(hits.map((h) => h.id)).toEqual(["p1"]);
    expect(hits[0]).toEqual({
      id: "p1",
      title: "Cotton tee",
      slug: "cotton-tee",
      status: "active",
    });
  });

  it("includes drafts and archived — unlike the storefront search", async () => {
    await seedProduct({
      id: "p1",
      slug: "secret-drop",
      status: "draft",
      titleEn: "Secret drop",
    });
    const hits = await searchAdminProducts(db, "secret");
    expect(hits.map((h) => h.status)).toEqual(["draft"]);
  });

  it("matches by slug even without an FTS title hit", async () => {
    await seedProduct({ id: "p1", slug: "sku-x9000", titleEn: "The niner" });
    const hits = await searchAdminProducts(db, "x9000");
    expect(hits.map((h) => h.id)).toEqual(["p1"]);
  });

  it("falls back to LIKE for 2-character queries", async () => {
    await seedProduct({ id: "p1", slug: "ao-yon", titleEn: "Ao Yon shirt" });
    const hits = await searchAdminProducts(db, "Ao");
    expect(hits.map((h) => h.id)).toEqual(["p1"]);
  });

  it("caps results at the requested limit", async () => {
    for (let i = 0; i < 8; i++) {
      await seedProduct({ id: `p${i}`, slug: `tee-${i}`, titleEn: `Tee ${i}` });
    }
    expect(await searchAdminProducts(db, "Tee", 5)).toHaveLength(5);
  });
});
