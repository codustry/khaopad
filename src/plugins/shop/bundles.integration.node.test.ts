import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { CartService } from "./cart-service";
import {
  commitVariantSaleWithComponents,
  getBundleAvailability,
  releaseVariantWithComponents,
  reserveVariantWithComponents,
  setBundleComponents,
} from "./bundles";
import { reserveVariant } from "./inventory";
import { ShopService } from "./service";

/**
 * #165 — fixed bundles against REAL SQLite with the REAL migrations
 * applied (same harness as checkout-start.integration.node.test.ts).
 *
 * These are the tests that matter for this feature. Bundle inventory
 * is money-adjacent and concurrency-sensitive, and the properties
 * being pinned here — all-or-nothing component reservation, no
 * oversell under a race, exact restoration on release — cannot be
 * demonstrated against a mock, because the thing doing the work is
 * SQLite's own atomicity on `UPDATE ... WHERE available >= qty`.
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/** Minimal D1Database shim over better-sqlite3, enough for Drizzle's d1 driver. */
function d1Shim(db: Database.Database): D1Database {
  const run = (sql: string, params: unknown[]) => {
    // D1 accepts `?1`-style numbered placeholders but better-sqlite3
    // rejects them when bound positionally. Rewrite to bare `?` and
    // expand params in placeholder order — inventory.ts reuses `?1`
    // twice in one statement, so a blind rewrite would under-bind.
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

const NOW = "2026-08-12T10:00:00.000Z";

/** A plain sellable variant with its own stock. */
function seedVariant(
  id: string,
  opts: { onHand?: number; isBundle?: boolean; tracked?: boolean } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, is_bundle, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
    )
    .run(`prod-${id}`, `prod-${id}`, opts.isBundle ? 1 : 0, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO shop_product_localizations (product_id, locale, title)
       VALUES (?, 'en', ?)`,
    )
    .run(`prod-${id}`, `Product ${id}`);
  sqlite
    .prepare(
      `INSERT INTO shop_product_variants
         (id, product_id, status, title_cached, price_satang)
       VALUES (?, ?, 'active', 'Default', 25000)`,
    )
    .run(id, `prod-${id}`);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_items (id, variant_id, tracked)
       VALUES (?, ?, ?)`,
    )
    .run(`inv-${id}`, id, opts.tracked === false ? 0 : 1);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_levels (item_id, location_id, on_hand, reserved)
       VALUES (?, 'default', ?, 0)`,
    )
    .run(`inv-${id}`, opts.onHand ?? 0);
}

/**
 * A bundle variant. Deliberately given NO inventory rows of its own —
 * a bundle owns no shelf; its availability is derived. If any code
 * path tried to reserve the bundle variant directly it would fail
 * NO_INVENTORY, which is exactly the loud failure we want.
 */
function seedBundle(id: string) {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, is_bundle, created_at, updated_at)
       VALUES (?, ?, 'active', 1, ?, ?)`,
    )
    .run(`prod-${id}`, `prod-${id}`, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO shop_product_localizations (product_id, locale, title)
       VALUES (?, 'en', ?)`,
    )
    .run(`prod-${id}`, `Bundle ${id}`);
  sqlite
    .prepare(
      `INSERT INTO shop_product_variants
         (id, product_id, status, title_cached, price_satang)
       VALUES (?, ?, 'active', 'Gift set', 89000)`,
    )
    .run(id, `prod-${id}`);
}

function levels(variantId: string) {
  return sqlite
    .prepare(
      `SELECT on_hand AS onHand, reserved
       FROM shop_inventory_levels WHERE item_id = ?`,
    )
    .get(`inv-${variantId}`) as { onHand: number; reserved: number };
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
  d1 = d1Shim(sqlite);
});

describe("#165 — selling a bundle moves every component", () => {
  it("reserve then commit decrements each component by bundleQty × componentQty", async () => {
    seedVariant("soap", { onHand: 20 });
    seedVariant("candle", { onHand: 20 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
      { componentVariantId: "candle", quantity: 1 },
    ]);

    // Buy 3 bundles → 6 soap, 3 candle.
    const outcome = await reserveVariantWithComponents(d1, "giftset", 3);
    expect(outcome.ok).toBe(true);
    expect(levels("soap")).toEqual({ onHand: 20, reserved: 6 });
    expect(levels("candle")).toEqual({ onHand: 20, reserved: 3 });

    // Payment lands: on_hand AND reserved both fall by the same amount,
    // so `available` stays truthful across the transition.
    await commitVariantSaleWithComponents(d1, "giftset", 3);
    expect(levels("soap")).toEqual({ onHand: 14, reserved: 0 });
    expect(levels("candle")).toEqual({ onHand: 17, reserved: 0 });
  });

  it("leaves the bundle variant itself with no stock rows to move", async () => {
    seedVariant("soap", { onHand: 5 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 1 },
    ]);
    await reserveVariantWithComponents(d1, "giftset", 1);

    const bundleLevels = sqlite
      .prepare(
        `SELECT * FROM shop_inventory_levels WHERE item_id = 'inv-giftset'`,
      )
      .all();
    expect(bundleLevels).toEqual([]);
  });
});

describe("#165 — availability is derived, never stored", () => {
  it("is min(floor(component.available / qty)) across components", async () => {
    seedVariant("soap", { onHand: 7 });
    seedVariant("candle", { onHand: 5 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 }, // 7 / 2 → 3
      { componentVariantId: "candle", quantity: 1 }, // 5 / 1 → 5
    ]);
    expect(await getBundleAvailability(d1, "giftset")).toBe(3);
  });

  it("shows SOLD OUT when one component runs dry, however full the rest are", async () => {
    seedVariant("soap", { onHand: 500 });
    seedVariant("candle", { onHand: 0 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 1 },
      { componentVariantId: "candle", quantity: 1 },
    ]);
    expect(await getBundleAvailability(d1, "giftset")).toBe(0);

    // And the storefront read agrees — this is the path the product
    // page's sold-out badge actually goes through.
    const svc = new ShopService(d1);
    const product = await svc.getProductBySlug("prod-giftset");
    expect(product?.variants[0].inventory?.available).toBe(0);
    expect(product?.variants[0].bundleComponents).toHaveLength(2);
  });

  it("falls as components are reserved by other shoppers", async () => {
    seedVariant("soap", { onHand: 10 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
    ]);
    expect(await getBundleAvailability(d1, "giftset")).toBe(5);

    // Someone buys 4 soaps directly — the bundle's ceiling drops.
    await reserveVariant(d1, "soap", 4);
    expect(await getBundleAvailability(d1, "giftset")).toBe(3);
  });

  it("returns null for a variant that is not a bundle", async () => {
    seedVariant("soap", { onHand: 10 });
    expect(await getBundleAvailability(d1, "soap")).toBeNull();
  });
});

describe("#165 — partial reservation rolls back cleanly", () => {
  it("releases the components it DID get when a later one is out of stock", async () => {
    // The core hazard. Without the unwind, the soap stays reserved to
    // a cart that can never check out — invisible-but-unsellable
    // stock until the 15-minute sweep.
    seedVariant("soap", { onHand: 100 });
    seedVariant("candle", { onHand: 0 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
      { componentVariantId: "candle", quantity: 1 },
    ]);

    const outcome = await reserveVariantWithComponents(d1, "giftset", 1);
    expect(outcome).toEqual({ ok: false, reason: "OUT_OF_STOCK" });

    // Soap must be back exactly where it started — no leak.
    expect(levels("soap")).toEqual({ onHand: 100, reserved: 0 });
    expect(levels("candle")).toEqual({ onHand: 0, reserved: 0 });
  });

  it("rolls back across many components, not just the previous one", async () => {
    for (const part of ["a", "b", "c", "d"]) {
      seedVariant(part, { onHand: 50 });
    }
    seedVariant("missing", { onHand: 0 });
    seedBundle("kit");
    await setBundleComponents(d1, "kit", [
      { componentVariantId: "a", quantity: 1 },
      { componentVariantId: "b", quantity: 2 },
      { componentVariantId: "c", quantity: 3 },
      { componentVariantId: "d", quantity: 4 },
      { componentVariantId: "missing", quantity: 1 },
    ]);

    const outcome = await reserveVariantWithComponents(d1, "kit", 2);
    expect(outcome.ok).toBe(false);
    for (const part of ["a", "b", "c", "d"]) {
      expect(levels(part)).toEqual({ onHand: 50, reserved: 0 });
    }
  });
});

describe("#165 — two shoppers racing the last component cannot both win", () => {
  it("exactly one of two concurrent bundle reservations succeeds", async () => {
    // One candle on the shelf; two bundles each need it.
    seedVariant("soap", { onHand: 100 });
    seedVariant("candle", { onHand: 1 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
      { componentVariantId: "candle", quantity: 1 },
    ]);

    const [first, second] = await Promise.all([
      reserveVariantWithComponents(d1, "giftset", 1),
      reserveVariantWithComponents(d1, "giftset", 1),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ ok: false, reason: "OUT_OF_STOCK" });

    // The candle is reserved exactly once — never 2 against on_hand 1.
    expect(levels("candle")).toEqual({ onHand: 1, reserved: 1 });
    // And the loser's soap was returned: only the winner's 2 are held.
    expect(levels("soap")).toEqual({ onHand: 100, reserved: 2 });
  });

  it("a bundle and a direct buyer cannot both take the last unit", async () => {
    seedVariant("candle", { onHand: 1 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "candle", quantity: 1 },
    ]);

    const [viaBundle, direct] = await Promise.all([
      reserveVariantWithComponents(d1, "giftset", 1),
      reserveVariant(d1, "candle", 1),
    ]);

    expect([viaBundle.ok, direct.ok].filter(Boolean)).toHaveLength(1);
    expect(levels("candle")).toEqual({ onHand: 1, reserved: 1 });
  });

  it("does not oversell when many bundles contend for a scarce component", async () => {
    seedVariant("soap", { onHand: 1000 });
    seedVariant("candle", { onHand: 5 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 1 },
      { componentVariantId: "candle", quantity: 1 },
    ]);

    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveVariantWithComponents(d1, "giftset", 1),
      ),
    );
    const succeeded = attempts.filter((a) => a.ok).length;

    // Only 5 candles exist, so at most 5 bundles can be held — and the
    // reserved counter must match the number of winners exactly.
    expect(succeeded).toBe(5);
    expect(levels("candle")).toEqual({ onHand: 5, reserved: 5 });
    expect(levels("soap").reserved).toBe(5);
  });
});

describe("#165 — release restores exactly what was reserved", () => {
  it("returns every component to its pre-reservation counters", async () => {
    seedVariant("soap", { onHand: 20 });
    seedVariant("candle", { onHand: 9 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 3 },
      { componentVariantId: "candle", quantity: 1 },
    ]);

    const before = { soap: levels("soap"), candle: levels("candle") };
    await reserveVariantWithComponents(d1, "giftset", 2);
    expect(levels("soap").reserved).toBe(6);
    expect(levels("candle").reserved).toBe(2);

    await releaseVariantWithComponents(d1, "giftset", 2);
    expect(levels("soap")).toEqual(before.soap);
    expect(levels("candle")).toEqual(before.candle);
  });

  it("leaves on_hand untouched — a release is not a sale", async () => {
    seedVariant("soap", { onHand: 20 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
    ]);
    await reserveVariantWithComponents(d1, "giftset", 4);
    await releaseVariantWithComponents(d1, "giftset", 4);
    expect(levels("soap")).toEqual({ onHand: 20, reserved: 0 });
  });

  it("does not steal a concurrent shopper's hold when releasing", async () => {
    seedVariant("soap", { onHand: 20 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
    ]);
    await reserveVariantWithComponents(d1, "giftset", 1); // shopper A: 2
    await reserveVariantWithComponents(d1, "giftset", 1); // shopper B: 2
    expect(levels("soap").reserved).toBe(4);

    await releaseVariantWithComponents(d1, "giftset", 1); // A abandons
    expect(levels("soap").reserved).toBe(2); // B's hold survives
  });
});

describe("#165 — a bundle must not contain a bundle", () => {
  it("rejects a component whose product is flagged as a bundle", async () => {
    seedVariant("soap", { onHand: 10 });
    seedBundle("inner");
    await setBundleComponents(d1, "inner", [
      { componentVariantId: "soap", quantity: 1 },
    ]);
    seedBundle("outer");

    await expect(
      setBundleComponents(d1, "outer", [
        { componentVariantId: "inner", quantity: 1 },
      ]),
    ).rejects.toThrow(/cannot contain another bundle/);
  });

  it("rejects a component that has component rows even if the flag was cleared", async () => {
    // Belt and braces: a product whose is_bundle was turned off but
    // whose component rows linger must still not be nestable, or the
    // expansion would go two levels deep.
    seedVariant("soap", { onHand: 10 });
    seedBundle("inner");
    await setBundleComponents(d1, "inner", [
      { componentVariantId: "soap", quantity: 1 },
    ]);
    sqlite
      .prepare(`UPDATE shop_products SET is_bundle = 0 WHERE id = 'prod-inner'`)
      .run();
    seedBundle("outer");

    await expect(
      setBundleComponents(d1, "outer", [
        { componentVariantId: "inner", quantity: 1 },
      ]),
    ).rejects.toThrow(/cannot contain another bundle/);
  });

  it("rejects a bundle containing itself", async () => {
    seedBundle("giftset");
    await expect(
      setBundleComponents(d1, "giftset", [
        { componentVariantId: "giftset", quantity: 1 },
      ]),
    ).rejects.toThrow(/cannot contain itself/);
  });

  it("rejects an unknown component variant", async () => {
    seedBundle("giftset");
    await expect(
      setBundleComponents(d1, "giftset", [
        { componentVariantId: "ghost", quantity: 1 },
      ]),
    ).rejects.toThrow(/Unknown component variant/);
  });

  it("rejects a non-positive or duplicated component quantity", async () => {
    seedVariant("soap", { onHand: 10 });
    seedBundle("giftset");
    await expect(
      setBundleComponents(d1, "giftset", [
        { componentVariantId: "soap", quantity: 0 },
      ]),
    ).rejects.toThrow(/positive integer/);
    await expect(
      setBundleComponents(d1, "giftset", [
        { componentVariantId: "soap", quantity: 1 },
        { componentVariantId: "soap", quantity: 2 },
      ]),
    ).rejects.toThrow(/only once/);
  });
});

describe("#165 — bundle component writes", () => {
  it("replaces the component list wholesale and preserves order", async () => {
    seedVariant("soap", { onHand: 10 });
    seedVariant("candle", { onHand: 10 });
    seedVariant("towel", { onHand: 10 });
    seedBundle("giftset");

    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 1 },
      { componentVariantId: "candle", quantity: 2 },
    ]);
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "towel", quantity: 3 },
      { componentVariantId: "soap", quantity: 5 },
    ]);

    const svc = new ShopService(d1);
    const comps = await svc.getBundleComponents("giftset");
    expect(comps.map((c) => [c.componentVariantId, c.quantity])).toEqual([
      ["towel", 3],
      ["soap", 5],
    ]);
  });

  it("clearing components makes the bundle unpurchasable rather than unlimited", async () => {
    seedVariant("soap", { onHand: 10 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 1 },
    ]);
    await setBundleComponents(d1, "giftset", []);

    const svc = new ShopService(d1);
    const product = await svc.getProductBySlug("prod-giftset");
    expect(product?.variants[0].inventory?.available).toBe(0);
  });

  it("omits bundle products from the component picker's candidates", async () => {
    seedVariant("soap", { onHand: 10 });
    seedBundle("giftset");
    const svc = new ShopService(d1);
    const candidates = await svc.listBundleCandidateVariants("prod-giftset");
    expect(candidates.map((c) => c.variantId)).toEqual(["soap"]);
  });
});

describe("#165 — the bundle price is fixed, never the sum of parts", () => {
  it("carries the bundle's own price into the cart, not the component total", async () => {
    seedVariant("soap", { onHand: 20 }); // 250.00 each
    seedVariant("candle", { onHand: 20 }); // 250.00 each
    seedBundle("giftset"); // 890.00 fixed
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
      { componentVariantId: "candle", quantity: 1 },
    ]);

    const cart = new CartService(d1);
    const created = await cart.ensureCart({ sessionId: "sess-bundle" });
    await cart.addItem({
      cartId: created.id,
      variantId: "giftset",
      quantity: 1,
    });

    const items = await cart.listCartItems(created.id);
    expect(items).toHaveLength(1);
    // Components would total 75,000 satang. The bundle's fixed 89,000
    // is what the customer is quoted, and what freezes into the order.
    expect(items[0].priceSatangAtAdd).toBe(89000);
  });

  it("reserves components through the ordinary checkout-start path", async () => {
    seedVariant("soap", { onHand: 20 });
    seedVariant("candle", { onHand: 20 });
    seedBundle("giftset");
    await setBundleComponents(d1, "giftset", [
      { componentVariantId: "soap", quantity: 2 },
      { componentVariantId: "candle", quantity: 1 },
    ]);

    const cart = new CartService(d1);
    const created = await cart.ensureCart({ sessionId: "sess-checkout" });
    await cart.addItem({
      cartId: created.id,
      variantId: "giftset",
      quantity: 2,
    });
    await cart.startCheckout({
      cartId: created.id,
      email: "buyer@example.com",
    });

    // Checkout-start needed no bundle-specific code: cart-service calls
    // the bundle-aware wrapper for every line.
    expect(levels("soap")).toEqual({ onHand: 20, reserved: 4 });
    expect(levels("candle")).toEqual({ onHand: 20, reserved: 2 });
  });
});
