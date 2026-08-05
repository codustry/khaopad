import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { CartService, RESERVATION_TTL_MS } from "./cart-service";
import { OrderService } from "./order-service";
import { quoteShipping } from "./shipping";

/**
 * #154 / #158 — checkout-start behaviour against REAL SQLite with the
 * REAL migrations applied (same harness as
 * src/lib/server/secrets/service.integration.node.test.ts).
 *
 * The whole point of #154 is that the UNIQUE (session_id, status)
 * index turns status-flips into landmines — so these tests must run
 * against a database that actually HAS that index, not a mock.
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
let svc: CartService;

const NOW = "2026-08-05T10:00:00.000Z";

function seedVariant(id: string, opts: { weightGrams?: number | null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(`prod-${id}`, `prod-${id}`, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO shop_product_variants
         (id, product_id, status, title_cached, price_satang, weight_grams)
       VALUES (?, ?, 'active', 'Default', 25000, ?)`,
    )
    .run(id, `prod-${id}`, opts.weightGrams ?? null);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_items (id, variant_id, tracked)
       VALUES (?, ?, 1)`,
    )
    .run(`inv-${id}`, id);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_levels (item_id, location_id, on_hand, reserved)
       VALUES (?, 'default', 100, 0)`,
    )
    .run(`inv-${id}`);
}

function seedCart(
  id: string,
  sessionId: string,
  status: string,
  opts: { checkoutStartedAt?: string; withItem?: string } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO shop_carts
         (id, session_id, status, checkout_started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, sessionId, status, opts.checkoutStartedAt ?? null, NOW, NOW);
  if (opts.withItem) {
    sqlite
      .prepare(
        `INSERT INTO shop_cart_items
           (id, cart_id, variant_id, quantity, price_satang_at_add, added_at)
         VALUES (?, ?, ?, 1, 25000, ?)`,
      )
      .run(`item-${id}`, id, opts.withItem, NOW);
  }
}

function cartRow(id: string) {
  return sqlite
    .prepare(
      `SELECT id, session_id, previous_session_id, status
       FROM shop_carts WHERE id = ?`,
    )
    .get(id) as {
    id: string;
    session_id: string;
    previous_session_id: string | null;
    status: string;
  };
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
  svc = new CartService(d1);
});

describe("#154 — supersede-by-rename on checkout retry", () => {
  it("a second checkout on the same session succeeds despite a stale checkout_started cart", async () => {
    seedVariant("var-1");
    // First checkout: cart A flips to checkout_started, then the
    // payment dies (nothing else happens).
    seedCart("cart-a", "sess-1", "open", { withItem: "var-1" });
    await svc.startCheckout({ cartId: "cart-a", email: "a@example.com" });
    expect(cartRow("cart-a").status).toBe("checkout_started");

    // Customer gets a fresh open cart on the same session and retries.
    // Pre-fix this threw a raw UNIQUE violation → opaque 500 forever.
    seedCart("cart-b", "sess-1", "open", { withItem: "var-1" });
    const result = await svc.startCheckout({
      cartId: "cart-b",
      email: "a@example.com",
    });
    expect(result.cart.status).toBe("checkout_started");

    // Old cart's slot was freed by rename, original session preserved.
    const oldCart = cartRow("cart-a");
    expect(oldCart.session_id).toBe("superseded:cart-a");
    expect(oldCart.previous_session_id).toBe("sess-1");

    // New cart owns the (sess-1, checkout_started) slot.
    const newCart = cartRow("cart-b");
    expect(newCart.session_id).toBe("sess-1");
    expect(newCart.status).toBe("checkout_started");
  });

  it("startCheckout with no stale sibling leaves session_id untouched", async () => {
    seedVariant("var-1");
    seedCart("cart-a", "sess-1", "open", { withItem: "var-1" });
    await svc.startCheckout({ cartId: "cart-a", email: "a@example.com" });
    const row = cartRow("cart-a");
    expect(row.session_id).toBe("sess-1");
    expect(row.previous_session_id).toBeNull();
  });
});

describe("#154 — sweep survives the expired-slot collision", () => {
  it("expires a stale checkout_started cart even when the session already owns an expired cart", async () => {
    seedVariant("var-1");
    // The landmine: session already has an `expired` cart occupying
    // the (sess-1, expired) slot...
    seedCart("cart-old", "sess-1", "expired");
    // ...and a checkout_started cart that went stale.
    const staleStart = new Date(
      Date.parse(NOW) - RESERVATION_TTL_MS - 60_000,
    ).toISOString();
    seedCart("cart-stale", "sess-1", "checkout_started", {
      checkoutStartedAt: staleStart,
      withItem: "var-1",
    });

    // Pre-fix the bulk status-flip hit the UNIQUE index and the whole
    // sweep run aborted. Now it must complete...
    await expect(
      svc.sweepExpiredReservations(new Date(NOW)),
    ).resolves.toBeDefined();

    // ...and both carts end up expired without colliding.
    const stale = cartRow("cart-stale");
    expect(stale.status).toBe("expired");
    expect(stale.session_id).toBe("superseded:cart-stale");
    expect(stale.previous_session_id).toBe("sess-1");
    expect(cartRow("cart-old").status).toBe("expired");
  });

  it("releases expired reservations and returns stock", async () => {
    seedVariant("var-1");
    seedCart("cart-a", "sess-1", "open", { withItem: "var-1" });
    await svc.startCheckout({ cartId: "cart-a", email: "a@example.com" });

    const reservedBefore = sqlite
      .prepare(`SELECT reserved FROM shop_inventory_levels`)
      .get() as { reserved: number };
    expect(reservedBefore.reserved).toBe(1);

    // Sweep 16 minutes later: reservation released, stock returned.
    // (startCheckout stamps expiry from the real clock, so "later"
    // must be relative to Date.now(), not the fixed seed time.)
    const later = new Date(Date.now() + RESERVATION_TTL_MS + 60_000);
    const released = await svc.sweepExpiredReservations(later);
    expect(released).toBe(1);
    const reservedAfter = sqlite
      .prepare(`SELECT reserved FROM shop_inventory_levels`)
      .get() as { reserved: number };
    expect(reservedAfter.reserved).toBe(0);
    expect(cartRow("cart-a").status).toBe("expired");
  });

  it("is idempotent — a second sweep on a tombstoned cart is a no-op", async () => {
    seedVariant("var-1");
    const staleStart = new Date(
      Date.parse(NOW) - RESERVATION_TTL_MS - 60_000,
    ).toISOString();
    seedCart("cart-stale", "sess-1", "checkout_started", {
      checkoutStartedAt: staleStart,
    });
    await svc.sweepExpiredReservations(new Date(NOW));
    await svc.sweepExpiredReservations(new Date(NOW));
    const row = cartRow("cart-stale");
    expect(row.status).toBe("expired");
    expect(row.session_id).toBe("superseded:cart-stale");
  });
});

describe("#158 — server-side shipping quotes", () => {
  function seedZone(countryCodes: string[]) {
    sqlite
      .prepare(
        `INSERT INTO shop_shipping_zones (id, name, priority, country_codes, created_at, updated_at)
         VALUES ('zone-1', 'Domestic', 1, ?, ?, ?)`,
      )
      .run(JSON.stringify(countryCodes), NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO shop_shipping_methods (id, zone_id, name, rate_type, active)
         VALUES ('method-flat', 'zone-1', 'Standard', 'flat', 1)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO shop_shipping_rates (id, method_id, amount_satang)
         VALUES ('rate-flat', 'method-flat', 5000)`,
      )
      .run();
  }

  it("quotes a configured zone by country", async () => {
    seedZone(["TH"]);
    const quotes = await quoteShipping(d1, {
      countryCode: "TH",
      totalWeightGrams: 500,
      subtotalSatang: 25000,
    });
    expect(quotes).toEqual([
      { methodId: "method-flat", name: "Standard", amountSatang: 5000 },
    ]);
  });

  it("a requested method id must match a server quote — unknown id finds nothing (never zero)", async () => {
    seedZone(["TH"]);
    const quotes = await quoteShipping(d1, {
      countryCode: "TH",
      totalWeightGrams: 500,
      subtotalSatang: 25000,
    });
    // The endpoint's contract: `quotes.find(...)` misses → 400
    // INVALID_SHIPPING_METHOD, never a silent fallback to 0.
    const chosen = quotes.find((q) => q.methodId === "client-invented-id");
    expect(chosen).toBeUndefined();
  });

  it("unconfigured store (no zones) quotes empty → checkout ships at 0", async () => {
    const quotes = await quoteShipping(d1, {
      countryCode: "TH",
      totalWeightGrams: 500,
      subtotalSatang: 25000,
    });
    expect(quotes).toEqual([]);
  });

  it("no matching zone for the country quotes empty", async () => {
    seedZone(["TH"]);
    const quotes = await quoteShipping(d1, {
      countryCode: "JP",
      totalWeightGrams: 500,
      subtotalSatang: 25000,
    });
    expect(quotes).toEqual([]);
  });

  it("getCartShippingContext sums subtotal and weight from cart rows", async () => {
    seedVariant("var-w", { weightGrams: 300 });
    seedCart("cart-a", "sess-1", "open");
    sqlite
      .prepare(
        `INSERT INTO shop_cart_items
           (id, cart_id, variant_id, quantity, price_satang_at_add, added_at)
         VALUES ('item-1', 'cart-a', 'var-w', 3, 25000, ?)`,
      )
      .run(NOW);
    const ctx = await svc.getCartShippingContext("cart-a");
    expect(ctx).toEqual({
      subtotalSatang: 75000,
      totalWeightGrams: 900,
      itemCount: 3,
    });
  });
});

describe("checkout/start endpoint glue (source-level)", () => {
  // The endpoint needs a SvelteKit request context to execute; the
  // repo's *-page.node.test.ts pattern pins glue by reading the source.
  const src = readFileSync(
    new URL("../../routes/api/shop/checkout/start/+server.ts", import.meta.url)
      .pathname,
    "utf8",
  );

  it("prices shipping via quoteShipping, never from the client", () => {
    expect(src).toContain("quoteShipping(");
    expect(src).toContain("INVALID_SHIPPING_METHOD");
    expect(src).toContain("SHIPPING_METHOD_REQUIRED");
    // The old hardcode is gone: shippingSatang flows into the order.
    expect(src).toMatch(/shippingSatang,/);
  });

  it("validates addresses through the shared validator", () => {
    expect(src).toContain("validateOrderAddress");
    expect(src).toContain("INVALID_ADDRESS");
    // The unchecked casts of the old implementation are gone.
    expect(src).not.toContain("as Parameters<");
  });

  it("catches unexpected errors and runs the opportunistic sweep", () => {
    expect(src).toContain("UNEXPECTED_ERROR");
    expect(src).toContain("console.error");
    expect(src).toContain("shop:lastSweepAt");
    expect(src).toContain("sweepExpiredReservations");
  });
});

describe("#154 — markPaid survives the ordered-slot collision", () => {
  // The third instance of the same disease, one layer deeper than the
  // checkout and the sweep: markPaid bulk-flipped carts to `ordered` by
  // (email, checkout_started). A returning customer whose SESSION
  // already owns an `ordered` cart from a previous purchase made that
  // UPDATE violate UNIQUE (session_id, status) — inside the payment
  // webhook, after inventory had committed: order paid in the DB, the
  // webhook 500ing, and the provider retrying against the idempotent
  // flip guard forever.
  function seedOrder(id: string, orderNumber: string, email: string) {
    sqlite
      .prepare(
        `INSERT INTO shop_orders
           (id, order_number, email, status, subtotal_satang, total_satang,
            created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 25000, 25000, ?, ?)`,
      )
      .run(id, orderNumber, email, NOW, NOW);
  }

  it("tombstones the prior ordered cart, then flips the fresh one", async () => {
    // Same session: a previous purchase's `ordered` cart occupies the
    // (session, ordered) slot; the new purchase's cart is mid-checkout.
    seedCart("cart-old", "sess-repeat", "ordered");
    seedCart("cart-new", "sess-repeat", "checkout_started");
    sqlite
      .prepare(`UPDATE shop_carts SET email = ? WHERE id IN (?, ?)`)
      .run("repeat@buyer.test", "cart-old", "cart-new");
    seedOrder("ord-1", "KHP-TEST-0001", "repeat@buyer.test");

    const orders = new OrderService(d1);
    // Before the fix this threw a raw UNIQUE violation.
    await orders.markPaid({ orderId: "ord-1", providerChargeId: "ch_real" });

    const oldCart = cartRow("cart-old");
    const newCart = cartRow("cart-new");
    // The fresh purchase owns the live `ordered` slot…
    expect(newCart.status).toBe("ordered");
    expect(newCart.session_id).toBe("sess-repeat");
    // …and the historical cart is tombstoned, traceably.
    expect(oldCart.status).toBe("ordered");
    expect(oldCart.session_id).toBe("superseded:cart-old");
    expect(oldCart.previous_session_id).toBe("sess-repeat");
  });

  it("no-ops cleanly for a first-time buyer", async () => {
    seedCart("cart-first", "sess-first", "checkout_started");
    sqlite
      .prepare(`UPDATE shop_carts SET email = ? WHERE id = ?`)
      .run("first@buyer.test", "cart-first");
    seedOrder("ord-2", "KHP-TEST-0002", "first@buyer.test");

    const orders = new OrderService(d1);
    await orders.markPaid({ orderId: "ord-2", providerChargeId: "ch_x" });

    const cart = cartRow("cart-first");
    expect(cart.status).toBe("ordered");
    expect(cart.session_id).toBe("sess-first");
  });
});
