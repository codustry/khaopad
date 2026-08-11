import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ShopService, ShopValidationError } from "./service";

/**
 * #160 C3 — product editor write paths against REAL SQLite with the
 * real migrations applied (same d1Shim harness as
 * checkout-start.integration.node.test.ts).
 *
 * The one behaviour that MUST be proven against a real engine is the
 * A3 stale-title hazard: `upsertLocalization` must refresh
 * `products_fts`, or an edited title keeps serving the old search
 * index entry forever. That is a cross-table effect no mock shows.
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

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

let sqlite: Database.Database;
let svc: ShopService;
let productId: string;
let variantId: string;

function ftsTitles(id: string): Array<{ locale: string; title: string }> {
  return sqlite
    .prepare(
      `SELECT locale, title FROM products_fts WHERE product_id = ? ORDER BY locale`,
    )
    .all(id) as Array<{ locale: string; title: string }>;
}

beforeEach(async () => {
  sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  svc = new ShopService(d1Shim(sqlite));
  productId = await svc.createProduct({
    status: "active",
    localizations: {
      en: { title: "Classic Tee", descriptionMarkdown: "Soft cotton." },
      th: { title: "เสื้อยืดคลาสสิก" },
    },
    variants: [{ sku: "CT-001", priceSatang: 19900, optionValueIds: [] }],
  });
  const product = await svc.getProduct(productId);
  variantId = product!.variants[0].id;
});

describe("upsertLocalization", () => {
  it("refreshes products_fts so an edited title does not go stale (A3)", async () => {
    // Sanity: the create path indexed the original title.
    expect(ftsTitles(productId).map((r) => r.title)).toContain("Classic Tee");

    await svc.upsertLocalization(productId, "en", {
      title: "Premium Tee",
      descriptionMarkdown: "Soft cotton.",
    });

    const titles = ftsTitles(productId).map((r) => r.title);
    expect(titles).toContain("Premium Tee");
    // THE pin: the stale entry must be gone — this is exactly the bug
    // flagged in the v3.14 PR review.
    expect(titles).not.toContain("Classic Tee");
  });

  it("persists the localization row and bumps product updatedAt", async () => {
    const before = (await svc.getProduct(productId))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await svc.upsertLocalization(productId, "en", { title: "Premium Tee" });
    const after = await svc.getProduct(productId);
    expect(after!.localizations["en"].title).toBe("Premium Tee");
    expect(after!.updatedAt >= before).toBe(true);
  });

  it("creates a locale that did not exist yet and indexes it", async () => {
    await svc.upsertLocalization(productId, "th", {
      title: "เสื้อยืดพรีเมียม",
    });
    const product = await svc.getProduct(productId);
    expect(product!.localizations["th"].title).toBe("เสื้อยืดพรีเมียม");
    expect(ftsTitles(productId).map((r) => r.title)).toContain(
      "เสื้อยืดพรีเมียม",
    );
  });

  it("clearing a non-English title removes the row AND its index entry", async () => {
    await svc.upsertLocalization(productId, "th", { title: "  " });
    const product = await svc.getProduct(productId);
    expect(product!.localizations["th"]).toBeUndefined();
    expect(ftsTitles(productId).map((r) => r.locale)).toEqual(["en"]);
  });

  it("rejects removing the English title", async () => {
    await expect(
      svc.upsertLocalization(productId, "en", { title: "" }),
    ).rejects.toBeInstanceOf(ShopValidationError);
  });
});

describe("updateVariant", () => {
  it("persists a price change", async () => {
    await svc.updateVariant(variantId, { priceSatang: 24900 });
    const product = await svc.getProduct(productId);
    expect(product!.variants[0].priceSatang).toBe(24900);
  });

  it("persists compare-at and SKU, and clears them with null", async () => {
    await svc.updateVariant(variantId, {
      compareAtSatang: 29900,
      sku: "CT-002",
    });
    let product = await svc.getProduct(productId);
    expect(product!.variants[0].compareAtSatang).toBe(29900);
    expect(product!.variants[0].sku).toBe("CT-002");

    await svc.updateVariant(variantId, { compareAtSatang: null, sku: null });
    product = await svc.getProduct(productId);
    expect(product!.variants[0].compareAtSatang).toBeNull();
    expect(product!.variants[0].sku).toBeNull();
  });

  it("rejects a non-positive price", async () => {
    await expect(
      svc.updateVariant(variantId, { priceSatang: 0 }),
    ).rejects.toBeInstanceOf(ShopValidationError);
    await expect(
      svc.updateVariant(variantId, { priceSatang: -100 }),
    ).rejects.toBeInstanceOf(ShopValidationError);
  });

  it("maps a duplicate SKU to a ShopValidationError, not a raw UNIQUE error", async () => {
    const otherId = await svc.createProduct({
      localizations: { en: { title: "Other Tee" } },
      variants: [{ sku: "OT-001", priceSatang: 9900, optionValueIds: [] }],
    });
    const other = await svc.getProduct(otherId);
    await expect(
      svc.updateVariant(other!.variants[0].id, { sku: "CT-001" }),
    ).rejects.toBeInstanceOf(ShopValidationError);
  });
});

describe("updateProduct", () => {
  it("persists vendor and productType without touching localizations", async () => {
    await svc.updateProduct(productId, {
      vendor: "Khao Pad Apparel",
      productType: "T-Shirt",
    });
    const product = await svc.getProduct(productId);
    expect(product!.vendor).toBe("Khao Pad Apparel");
    expect(product!.productType).toBe("T-Shirt");
    expect(product!.localizations["en"].title).toBe("Classic Tee");
  });

  it("only writes the keys present on fields (PATCH semantics)", async () => {
    await svc.updateProduct(productId, { vendor: "Khao Pad Apparel" });
    await svc.updateProduct(productId, { productType: "T-Shirt" });
    const product = await svc.getProduct(productId);
    expect(product!.vendor).toBe("Khao Pad Apparel");
    expect(product!.productType).toBe("T-Shirt");
  });

  it("throws for an unknown product id", async () => {
    await expect(
      svc.updateProduct("nope", { vendor: "x" }),
    ).rejects.toBeInstanceOf(ShopValidationError);
  });
});
