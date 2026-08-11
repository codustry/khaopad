import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { CartService } from "./cart-service";
import { OrderService } from "./order-service";
import { quoteShipping } from "./shipping";
import { validateDiscount } from "./discount-service";
import { resolveTaxRate } from "./tax";
import { computeTotals } from "./totals";

/**
 * #111 (Phase B, B1) — totals-engine integration harness: REAL SQLite
 * with the REAL migrations, replaying the exact sequence
 * /api/shop/checkout/start performs (quote shipping → validate
 * discount → resolve tax → computeTotals → createFromCart), then
 * asserting on the persisted order rows.
 *
 * These tests were written failing-first against the old engine
 * (calculateTax's per-line rounding on the undiscounted subtotal,
 * checkout never charging tax at all) and now pin the fixed engine
 * in totals.ts. Recorded phase-1 failures:
 *   #107 — tax_satang 0 (route) / 2100 (engine on sticker) vs 1890
 *   #112 — 1,000 × 7-satang lines taxed 0 vs 490
 *   #108 — refundable line sum 30000 vs 27000 captured
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/** Minimal D1Database shim over better-sqlite3 (same as checkout-start harness). */
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
let d1: D1Database;
let carts: CartService;
let orders: OrderService;

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
  d1 = d1Shim(sqlite);
  carts = new CartService(d1);
  orders = new OrderService(d1);
});

// ─── Seed helpers ───────────────────────────────────────────

function seedVariant(id: string, priceSatang: number) {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(`prod-${id}`, `prod-${id}`, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO shop_product_variants
         (id, product_id, status, title_cached, price_satang)
       VALUES (?, ?, 'active', 'Default', ?)`,
    )
    .run(id, `prod-${id}`, priceSatang);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_items (id, variant_id, tracked)
       VALUES (?, ?, 1)`,
    )
    .run(`inv-${id}`, id);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_levels (item_id, location_id, on_hand, reserved)
       VALUES (?, 'default', 1000, 0)`,
    )
    .run(`inv-${id}`);
}

/** Cart in checkout_started with the given lines (variantId → qty×price). */
function seedCheckoutCart(
  cartId: string,
  lines: Array<{ variantId: string; quantity: number; priceSatang: number }>,
) {
  sqlite
    .prepare(
      `INSERT INTO shop_carts (id, session_id, status, checkout_started_at, created_at, updated_at)
       VALUES (?, ?, 'checkout_started', ?, ?, ?)`,
    )
    .run(cartId, `sess-${cartId}`, NOW, NOW, NOW);
  for (const [i, line] of lines.entries()) {
    sqlite
      .prepare(
        `INSERT INTO shop_cart_items
           (id, cart_id, variant_id, quantity, price_satang_at_add, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `item-${cartId}-${i}`,
        cartId,
        line.variantId,
        line.quantity,
        line.priceSatang,
        NOW,
      );
  }
}

function seedTaxSettings(settings: {
  enabled: boolean;
  defaultRatePct: number;
  pricesIncludeTax: boolean;
}) {
  sqlite
    .prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES ('shop.tax', ?, ?)`,
    )
    .run(JSON.stringify({ ...settings, defaultTaxName: "VAT" }), NOW);
}

function seedPercentDiscount(code: string, pct: number) {
  sqlite
    .prepare(
      `INSERT INTO shop_discount_codes
         (id, code, kind, value_percent, active, created_at, updated_at)
       VALUES (?, ?, 'percent', ?, 1, ?, ?)`,
    )
    .run(`disc-${code}`, code, pct, NOW, NOW);
}

function orderRow(orderId: string) {
  return sqlite
    .prepare(
      `SELECT subtotal_satang, shipping_satang, tax_satang, discount_satang, total_satang
       FROM shop_orders WHERE id = ?`,
    )
    .get(orderId) as {
    subtotal_satang: number;
    shipping_satang: number;
    tax_satang: number;
    discount_satang: number;
    total_satang: number;
  };
}

// ─── #107 — VAT on actual consideration ─────────────────────

describe("#107 — VAT must be computed on actual consideration (subtotal − discount + shipping)", () => {
  it("checkout sequence charges 7% VAT on (subtotal − discount + shipping) in prices-exclusive mode", async () => {
    // 3 × ฿100 goods, 10% discount, no shipping. Consideration is
    // ฿270 → VAT (7%, exclusive) = ฿18.90 = 1890 satang.
    seedTaxSettings({
      enabled: true,
      defaultRatePct: 7,
      pricesIncludeTax: false,
    });
    seedVariant("var-a", 10000);
    seedCheckoutCart("cart-107", [
      { variantId: "var-a", quantity: 3, priceSatang: 10000 },
    ]);
    seedPercentDiscount("TEN", 10);

    // Replay the checkout-start sequence exactly as the route does.
    const ctx = await carts.getCartShippingContext("cart-107");
    await quoteShipping(d1, {
      countryCode: "TH",
      totalWeightGrams: ctx.totalWeightGrams,
      subtotalSatang: ctx.subtotalSatang,
    });
    const outcome = await validateDiscount(d1, {
      code: "TEN",
      subtotalSatang: ctx.subtotalSatang,
      shippingSatang: 0,
      userId: null,
      userEmail: "b@example.com",
    });
    expect(outcome.ok).toBe(true);
    const discountSatang = outcome.ok ? outcome.amountSatang : 0;

    const cartLines = await carts.listCartItems("cart-107");
    const taxRate = await resolveTaxRate(d1, { countryCode: "TH" });
    const totals = computeTotals({
      lines: cartLines.map((item) => ({
        id: item.id,
        amountSatang: item.priceSatangAtAdd * item.quantity,
      })),
      shippingSatang: 0,
      discountSatang,
      tax: taxRate,
    });

    const { orderId } = await orders.createFromCart({
      cartId: "cart-107",
      email: "b@example.com",
      providerName: "beam",
      shippingSatang: 0,
      taxSatang: totals.taxSatang,
      discountSatang: totals.discountSatang,
    });

    const row = orderRow(orderId);
    expect(row.discount_satang).toBe(3000);
    // VAT on the ฿270 actually received — NOT on the ฿300 sticker.
    expect(row.tax_satang).toBe(1890);
    expect(row.total_satang).toBe(30000 - 3000 + 1890);
  });

  it("prices-inclusive mode (Thai default): total stays at sticker, VAT extracted for the receipt", async () => {
    seedTaxSettings({
      enabled: true,
      defaultRatePct: 7,
      pricesIncludeTax: true,
    });
    seedVariant("var-i", 10000);
    seedCheckoutCart("cart-incl", [
      { variantId: "var-i", quantity: 3, priceSatang: 10000 },
    ]);

    const cartLines = await carts.listCartItems("cart-incl");
    const taxRate = await resolveTaxRate(d1, { countryCode: "TH" });
    expect(taxRate.pricesIncludeTax).toBe(true);
    const totals = computeTotals({
      lines: cartLines.map((item) => ({
        id: item.id,
        amountSatang: item.priceSatangAtAdd * item.quantity,
      })),
      shippingSatang: 0,
      discountSatang: 0,
      tax: taxRate,
    });
    // gross ฿300 → VAT included = 30000 × 7/107 = 1962.6… → 1963.
    expect(totals.taxSatang).toBe(0);
    expect(totals.taxIncludedSatang).toBe(1963);

    const { orderId } = await orders.createFromCart({
      cartId: "cart-incl",
      email: "i@example.com",
      providerName: "beam",
      taxSatang: totals.taxSatang,
      discountSatang: 0,
    });
    const row = orderRow(orderId);
    // Customer pays the sticker price — no tax added on top.
    expect(row.tax_satang).toBe(0);
    expect(row.total_satang).toBe(30000);
  });

  it("per-country override beats the site default rate", async () => {
    seedTaxSettings({
      enabled: true,
      defaultRatePct: 7,
      pricesIncludeTax: false,
    });
    sqlite
      .prepare(
        `INSERT INTO shop_tax_rates (country_code, region_code, name, rate_pct, active)
         VALUES ('SG', '', 'GST', 9, 1)`,
      )
      .run();
    expect((await resolveTaxRate(d1, { countryCode: "SG" })).ratePct).toBe(9);
    expect((await resolveTaxRate(d1, { countryCode: "TH" })).ratePct).toBe(7);
  });

  it("a discounted order pays strictly less VAT than the same order undiscounted", async () => {
    seedTaxSettings({
      enabled: true,
      defaultRatePct: 7,
      pricesIncludeTax: false,
    });
    const taxRate = await resolveTaxRate(d1, { countryCode: "TH" });
    const base = {
      lines: [{ id: "a", amountSatang: 30000 }],
      shippingSatang: 0,
      tax: taxRate,
    };
    const undiscounted = computeTotals({ ...base, discountSatang: 0 });
    const discounted = computeTotals({ ...base, discountSatang: 3000 });
    expect(discounted.taxSatang).toBeLessThan(undiscounted.taxSatang);
  });
});

// ─── #112 — one rounding point at the order level ───────────

describe("#112 — VAT rounds once at the order level, not per line", () => {
  it("1,000 cheap lines: per-line rounding must not diverge from round-of-sum", async () => {
    seedTaxSettings({
      enabled: true,
      defaultRatePct: 7,
      pricesIncludeTax: false,
    });
    // 1,000 lines of 7 satang. Per-line (the removed calculateTax):
    // 7 × 7% = 0.49 → rounds to 0, a thousand times — tax vanished.
    // Order-level: 7,000 × 7% = 490 satang exactly.
    const taxRate = await resolveTaxRate(d1, { countryCode: "TH" });
    const totals = computeTotals({
      lines: Array.from({ length: 1000 }, (_, i) => ({
        id: `line-${i}`,
        amountSatang: 7,
      })),
      shippingSatang: 0,
      discountSatang: 0,
      tax: taxRate,
    });
    expect(totals.taxSatang).toBe(490);
  });
});

// ─── #108 — per-line discount allocation ────────────────────

describe("#108 — per-line discount allocation (over-refund reproduction)", () => {
  it("computeTotals allocations reconcile every line against the captured goods total", async () => {
    // The engine-side fix: Σ(line − allocation) === goods consideration
    // exactly. This is what the refund path must read once the B6
    // migration adds `discount_allocated_satang` to shop_order_items.
    const totals = computeTotals({
      lines: [
        { id: "r1", amountSatang: 10000 },
        { id: "r2", amountSatang: 10000 },
        { id: "r3", amountSatang: 10000 },
      ],
      shippingSatang: 0,
      discountSatang: 3000,
      tax: { enabled: false, ratePct: 0, pricesIncludeTax: false },
    });
    const refundableSum = totals.allocations.reduce(
      (sum, a, i) => sum + (10000 - a.discountAllocatedSatang) + i * 0,
      0,
    );
    expect(refundableSum).toBe(27000);
    expect(totals.totalSatang).toBe(27000);
  });

  // Written failing-first (phase-1: refundable sum 30000 vs 27000
  // captured); the B6 migration added `discount_allocated_satang`
  // and createFromCart now persists the allocation, so this passes.
  it("PERSISTED per-line values reconcile with the captured goods total on a discounted order", async () => {
    // The issue's exact reproduction: 3 lines × ฿100, 10% order
    // discount → customer pays ฿270 for the goods. Refunding every
    // line at its stored value must return exactly ฿270 — today the
    // lines store the undiscounted ฿100 each (฿300 total).
    seedVariant("var-r1", 10000);
    seedVariant("var-r2", 10000);
    seedVariant("var-r3", 10000);
    seedCheckoutCart("cart-108", [
      { variantId: "var-r1", quantity: 1, priceSatang: 10000 },
      { variantId: "var-r2", quantity: 1, priceSatang: 10000 },
      { variantId: "var-r3", quantity: 1, priceSatang: 10000 },
    ]);
    const { orderId } = await orders.createFromCart({
      cartId: "cart-108",
      email: "r@example.com",
      providerName: "beam",
      discountSatang: 3000,
    });
    const row = orderRow(orderId);
    expect(row.total_satang).toBe(27000);

    const items = sqlite
      .prepare(
        `SELECT line_subtotal_satang, discount_allocated_satang
         FROM shop_order_items WHERE order_id = ?`,
      )
      .all(orderId) as Array<{
      line_subtotal_satang: number;
      discount_allocated_satang: number;
    }>;
    // Refunds read line − allocation: 3 × (10000 − 1000) = ฿270 —
    // exactly what was captured, not the ฿300 sticker sum.
    const refundableSum = items.reduce(
      (s, i) => s + i.line_subtotal_satang - i.discount_allocated_satang,
      0,
    );
    expect(refundableSum).toBe(row.total_satang);
    const allocatedSum = items.reduce(
      (s, i) => s + i.discount_allocated_satang,
      0,
    );
    expect(allocatedSum).toBe(3000);
  });
});

// ─── checkout/start glue (source-level) ─────────────────────

describe("checkout/start totals glue (source-level)", () => {
  // Same pattern as checkout-start.integration.node.test.ts: the
  // endpoint needs a SvelteKit request context, so the wiring is
  // pinned by reading the source.
  const src = readFileSync(
    new URL("../../routes/api/shop/checkout/start/+server.ts", import.meta.url)
      .pathname,
    "utf8",
  );

  it("computes totals through the pure engine, not inline math", () => {
    expect(src).toContain("computeTotals(");
    expect(src).toContain("resolveTaxRate(");
    expect(src).toContain("taxSatang: totals.taxSatang");
    expect(src).toContain("discountSatang: totals.discountSatang");
  });

  it("resolves the tax rate from the shipping destination", () => {
    expect(src).toContain("shippingAddress?.countryCode");
  });

  it("passes the free-shipping flag so goods lines carry no allocation", () => {
    expect(src).toContain("discountIsFreeShipping");
  });

  it("order creation carries the B6 allocation note (#108)", () => {
    expect(src).toContain("B6 (#108)");
  });
});
