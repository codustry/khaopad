import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  OrderService,
  deriveLegacyStatus,
  type OrderFinancialStatus,
  type OrderFulfillmentStatus,
} from "./order-service";

/**
 * #109 / #110 / #113 — order status axes, adjustments ledger, and
 * domain-event emission against REAL SQLite with the REAL migrations
 * applied (same replay harness as
 * checkout-start.integration.node.test.ts).
 *
 * Backfill tests apply migrations only THROUGH 0024, seed legacy
 * single-axis orders, then replay 0025 — proving the migration maps
 * every legacy status correctly on production-shaped data.
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigration(db: Database.Database, file: string) {
  const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    if (stmt.trim()) db.exec(stmt);
  }
}

function applyMigrations(
  db: Database.Database,
  opts: { through?: string } = {},
) {
  for (const file of migrationFiles()) {
    if (opts.through && file > opts.through) break;
    applyMigration(db, file);
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

const NOW = "2026-08-10T10:00:00.000Z";

type RecordedEvent = { event: string; payload: Record<string, unknown> };

// ─── Seed helpers ───────────────────────────────────────────

function seedLegacyOrder(
  db: Database.Database,
  id: string,
  status: string,
  opts: {
    fulfilledAt?: string;
    deliveredAt?: string;
    totalSatang?: number;
  } = {},
) {
  db.prepare(
    `INSERT INTO shop_orders
       (id, order_number, email, status, subtotal_satang, total_satang,
        fulfilled_at, delivered_at, created_at, updated_at)
     VALUES (?, ?, 'buyer@example.com', ?, 25000, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `KHP-2026-${id}`,
    status,
    opts.totalSatang ?? 25000,
    opts.fulfilledAt ?? null,
    opts.deliveredAt ?? null,
    NOW,
    NOW,
  );
}

function seedVariant(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO shop_products (id, slug, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(`prod-${id}`, `prod-${id}`, NOW, NOW);
  db.prepare(
    `INSERT INTO shop_product_variants
       (id, product_id, status, title_cached, price_satang)
     VALUES (?, ?, 'active', 'Default', 25000)`,
  ).run(id, `prod-${id}`);
  db.prepare(
    `INSERT INTO shop_inventory_items (id, variant_id, tracked)
     VALUES (?, ?, 1)`,
  ).run(`inv-${id}`, id);
  db.prepare(
    `INSERT INTO shop_inventory_levels (item_id, location_id, on_hand, reserved)
     VALUES (?, 'default', 100, 5)`,
  ).run(`inv-${id}`);
}

function seedCheckoutCart(
  db: Database.Database,
  id: string,
  opts: { items?: Array<{ variantId: string; qty: number }> } = {},
) {
  db.prepare(
    `INSERT INTO shop_carts
       (id, session_id, email, status, checkout_started_at, created_at, updated_at)
     VALUES (?, ?, 'buyer@example.com', 'checkout_started', ?, ?, ?)`,
  ).run(id, `sess-${id}`, NOW, NOW, NOW);
  for (const [i, item] of (opts.items ?? []).entries()) {
    db.prepare(
      `INSERT INTO shop_cart_items
         (id, cart_id, variant_id, quantity, price_satang_at_add, added_at)
       VALUES (?, ?, ?, ?, 25000, ?)`,
    ).run(`item-${id}-${i}`, id, item.variantId, item.qty, NOW);
  }
}

function orderRow(db: Database.Database, id: string) {
  return db
    .prepare(
      `SELECT id, status, financial_status, fulfillment_status, return_status,
              channel, refunded_at
       FROM shop_orders WHERE id = ?`,
    )
    .get(id) as {
    id: string;
    status: string;
    financial_status: string;
    fulfillment_status: string;
    return_status: string | null;
    channel: string;
    refunded_at: string | null;
  };
}

// ─── #109 — migration 0025 backfill ─────────────────────────

describe("#109 — 0025 backfills the axes from every legacy status", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite, { through: "0024_products_fts.sql" });
  });

  const backfillMap: Array<{
    legacy: string;
    opts?: { fulfilledAt?: string; deliveredAt?: string };
    financial: string;
    fulfillment: string;
  }> = [
    { legacy: "pending", financial: "pending", fulfillment: "unfulfilled" },
    { legacy: "paid", financial: "paid", fulfillment: "unfulfilled" },
    { legacy: "fulfilled", financial: "paid", fulfillment: "fulfilled" },
    { legacy: "delivered", financial: "paid", fulfillment: "delivered" },
    { legacy: "refunded", financial: "refunded", fulfillment: "unfulfilled" },
    {
      legacy: "refunded",
      opts: { fulfilledAt: NOW },
      financial: "refunded",
      fulfillment: "fulfilled",
    },
    {
      legacy: "refunded",
      opts: { fulfilledAt: NOW, deliveredAt: NOW },
      financial: "refunded",
      fulfillment: "delivered",
    },
    { legacy: "cancelled", financial: "cancelled", fulfillment: "unfulfilled" },
  ];

  it("maps every legacy status onto the correct axes", () => {
    for (const [i, c] of backfillMap.entries()) {
      seedLegacyOrder(sqlite, `ord-${i}`, c.legacy, c.opts);
    }
    applyMigration(sqlite, "0025_order_axes_ledger.sql");
    for (const [i, c] of backfillMap.entries()) {
      const row = orderRow(sqlite, `ord-${i}`);
      expect(row.financial_status, `case ${i}: ${c.legacy}`).toBe(c.financial);
      expect(row.fulfillment_status, `case ${i}: ${c.legacy}`).toBe(
        c.fulfillment,
      );
      expect(row.return_status).toBeNull();
      expect(row.channel).toBe("online_store");
      // The legacy column itself is untouched by the migration.
      expect(row.status).toBe(c.legacy);
    }
  });

  it("deriveLegacyStatus round-trips the backfilled axes to the legacy status", () => {
    for (const c of backfillMap) {
      expect(
        deriveLegacyStatus(
          c.financial as OrderFinancialStatus,
          c.fulfillment as OrderFulfillmentStatus,
        ),
      ).toBe(c.legacy);
    }
  });

  it("adds the ledger + line-item columns", () => {
    seedLegacyOrder(sqlite, "ord-fk", "paid");
    applyMigration(sqlite, "0025_order_axes_ledger.sql");
    const adjCols = sqlite
      .prepare(`PRAGMA table_info(shop_order_adjustments)`)
      .all()
      .map((c) => (c as { name: string }).name);
    expect(adjCols).toContain("provider_refund_id");
    expect(adjCols).toContain("idempotency_key");
    const itemCols = sqlite
      .prepare(`PRAGMA table_info(shop_order_items)`)
      .all()
      .map((c) => (c as { name: string }).name);
    expect(itemCols).toContain("discount_allocated_satang");
    // The dedupe constraint is real, and partial (NULLs never collide).
    sqlite
      .prepare(
        `INSERT INTO shop_order_adjustments
           (id, order_id, kind, amount_satang, created_at, idempotency_key)
         VALUES ('a1', 'ord-fk', 'refund_partial', -100, ?, 'key-1')`,
      )
      .run(NOW);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO shop_order_adjustments
             (id, order_id, kind, amount_satang, created_at, idempotency_key)
           VALUES ('a2', 'ord-fk', 'refund_partial', -100, ?, 'key-1')`,
        )
        .run(NOW),
    ).toThrow(/UNIQUE/);
    // Two NULL-key legacy-style rows coexist fine.
    for (const id of ["a3", "a4"]) {
      sqlite
        .prepare(
          `INSERT INTO shop_order_adjustments
             (id, order_id, kind, amount_satang, created_at)
           VALUES (?, 'ord-fk', 'refund_partial', -100, ?)`,
        )
        .run(id, NOW);
    }
  });
});

describe("deriveLegacyStatus — full map", () => {
  it("covers every axis combination", () => {
    const expected: Record<string, Record<string, string>> = {
      pending: {
        unfulfilled: "pending",
        fulfilled: "pending",
        delivered: "pending",
      },
      paid: {
        unfulfilled: "paid",
        fulfilled: "fulfilled",
        delivered: "delivered",
      },
      partially_refunded: {
        unfulfilled: "paid",
        fulfilled: "fulfilled",
        delivered: "delivered",
      },
      refunded: {
        unfulfilled: "refunded",
        fulfilled: "refunded",
        delivered: "refunded",
      },
      cancelled: {
        unfulfilled: "cancelled",
        fulfilled: "cancelled",
        delivered: "cancelled",
      },
    };
    for (const [fin, byFul] of Object.entries(expected)) {
      for (const [ful, legacy] of Object.entries(byFul)) {
        expect(
          deriveLegacyStatus(
            fin as OrderFinancialStatus,
            ful as OrderFulfillmentStatus,
          ),
          `${fin} × ${ful}`,
        ).toBe(legacy);
      }
    }
  });
});

// ─── #110 — refund ledger + idempotency ─────────────────────

describe("#110 — adjustments ledger is authoritative for refunds", () => {
  let sqlite: Database.Database;
  let d1: D1Database;
  let svc: OrderService;
  let events: RecordedEvent[];

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    d1 = d1Shim(sqlite);
    events = [];
    svc = new OrderService(d1, {
      emitEvent: (event, payload) => events.push({ event, payload }),
    });
  });

  function seedPaidOrder(id: string, totalSatang: number) {
    sqlite
      .prepare(
        `INSERT INTO shop_orders
           (id, order_number, email, status, financial_status,
            subtotal_satang, total_satang, created_at, updated_at, paid_at)
         VALUES (?, ?, 'buyer@example.com', 'paid', 'paid', ?, ?, ?, ?, ?)`,
      )
      .run(id, `KHP-2026-${id}`, totalSatang, totalSatang, NOW, NOW, NOW);
  }

  function ledgerRows(orderId: string) {
    return sqlite
      .prepare(
        `SELECT id, kind, amount_satang, idempotency_key, provider_refund_id
         FROM shop_order_adjustments WHERE order_id = ? ORDER BY rowid`,
      )
      .all(orderId) as Array<{
      id: string;
      kind: string;
      amount_satang: number;
      idempotency_key: string | null;
      provider_refund_id: string | null;
    }>;
  }

  it("replaying a refund with the same key is a no-op returning the original row", async () => {
    seedPaidOrder("ord-1", 70000);
    const first = await svc.recordRefund({
      orderId: "ord-1",
      amountSatang: 30000,
      kind: "refund_partial",
      idempotencyKey: "admin-key-1",
      providerRefundId: "re_beam_1",
    });
    const replay = await svc.recordRefund({
      orderId: "ord-1",
      amountSatang: 30000,
      kind: "refund_partial",
      idempotencyKey: "admin-key-1",
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.adjustmentId).toBe(first.adjustmentId);
    const rows = ledgerRows("ord-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_satang).toBe(-30000);
    expect(rows[0].provider_refund_id).toBe("re_beam_1");
    // Only ONE order.refunded event — the replay emits nothing.
    expect(events.filter((e) => e.event === "order.refunded")).toHaveLength(1);
  });

  it("the same key with a different amount errors (body-fingerprint)", async () => {
    seedPaidOrder("ord-1", 70000);
    await svc.recordRefund({
      orderId: "ord-1",
      amountSatang: 30000,
      kind: "refund_partial",
      idempotencyKey: "admin-key-1",
    });
    await expect(
      svc.recordRefund({
        orderId: "ord-1",
        amountSatang: 20000,
        kind: "refund_partial",
        idempotencyKey: "admin-key-1",
      }),
    ).rejects.toThrow(/already used for a different refund/);
    expect(ledgerRows("ord-1")).toHaveLength(1);
  });

  it("partial refunds accumulate and flip financial_status at the thresholds", async () => {
    seedPaidOrder("ord-1", 70000);

    const first = await svc.recordRefund({
      orderId: "ord-1",
      amountSatang: 30000,
      kind: "refund_partial",
      idempotencyKey: "k-1",
    });
    expect(first.financialStatus).toBe("partially_refunded");
    let row = orderRow(sqlite, "ord-1");
    expect(row.financial_status).toBe("partially_refunded");
    // Legacy axis: partial refunds never made an order 'refunded'.
    expect(row.status).toBe("paid");
    expect(row.refunded_at).toBeNull();

    const second = await svc.recordRefund({
      orderId: "ord-1",
      amountSatang: 40000,
      kind: "refund_partial",
      idempotencyKey: "k-2",
    });
    expect(second.financialStatus).toBe("refunded");
    expect(second.refundedTotalSatang).toBe(70000);
    row = orderRow(sqlite, "ord-1");
    expect(row.financial_status).toBe("refunded");
    expect(row.status).toBe("refunded");
    expect(row.refunded_at).not.toBeNull();

    // Ledger sum IS the refunded total — two rows, no counter anywhere.
    expect(ledgerRows("ord-1")).toHaveLength(2);
    expect(await svc.refundedTotalSatang("ord-1")).toBe(70000);
    expect(await svc.paidTotalSatang("ord-1")).toBe(0);
    expect(await svc.refundableSatang("ord-1")).toBe(0);
  });

  it("the domain guard rejects a refund exceeding the ledger-derived balance", async () => {
    seedPaidOrder("ord-1", 70000);
    await svc.recordRefund({
      orderId: "ord-1",
      amountSatang: 50000,
      kind: "refund_partial",
      idempotencyKey: "k-1",
    });
    await expect(
      svc.recordRefund({
        orderId: "ord-1",
        amountSatang: 50000,
        kind: "refund_partial",
        idempotencyKey: "k-2",
      }),
    ).rejects.toThrow(/exceeds remaining refundable/);
    expect(ledgerRows("ord-1")).toHaveLength(1);
    expect(await svc.refundableSatang("ord-1")).toBe(20000);
  });
});

// ─── #109 / #113 — lifecycle transitions + event emission ───

describe("#109/#113 — transitions write the axes and emit domain events", () => {
  let sqlite: Database.Database;
  let d1: D1Database;
  let svc: OrderService;
  let events: RecordedEvent[];

  beforeEach(() => {
    sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    d1 = d1Shim(sqlite);
    events = [];
    svc = new OrderService(d1, {
      emitEvent: (event, payload) => events.push({ event, payload }),
    });
  });

  async function createOrder(
    opts: { discountSatang?: number; discountIsFreeShipping?: boolean } = {},
  ) {
    seedVariant(sqlite, "var-1");
    seedVariant(sqlite, "var-2");
    seedCheckoutCart(sqlite, "cart-1", {
      items: [
        { variantId: "var-1", qty: 2 },
        { variantId: "var-2", qty: 1 },
      ],
    });
    return svc.createFromCart({
      cartId: "cart-1",
      email: "buyer@example.com",
      providerName: "beam",
      discountSatang: opts.discountSatang,
      discountIsFreeShipping: opts.discountIsFreeShipping,
    });
  }

  it("createFromCart starts at pending/unfulfilled/online_store and emits order.created", async () => {
    const { orderId, orderNumber } = await createOrder();
    const row = orderRow(sqlite, orderId);
    expect(row.status).toBe("pending");
    expect(row.financial_status).toBe("pending");
    expect(row.fulfillment_status).toBe("unfulfilled");
    expect(row.return_status).toBeNull();
    expect(row.channel).toBe("online_store");

    expect(events).toHaveLength(1);
    const { event, payload } = events[0];
    expect(event).toBe("order.created");
    expect(payload).toMatchObject({
      orderId,
      orderNumber,
      channel: "online_store",
      status: "pending",
      financialStatus: "pending",
      fulfillmentStatus: "unfulfilled",
      returnStatus: null,
      subtotalSatang: 75000,
      totalSatang: 75000,
      currency: "THB",
    });
    // No customer PII in event payloads (#113).
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("shippingAddressJson");
  });

  it("free-shipping discounts allocate ZERO to goods lines", async () => {
    // The discount belongs to the shipping charge (totals.ts makes the
    // same split). Spreading it across goods lines would understate
    // their refundable value and under-refund returns on free-shipping
    // orders — the integration mismatch caught between the B1-B4 and
    // B5-B7 workstreams.
    const { orderId } = await createOrder({
      discountSatang: 5000,
      discountIsFreeShipping: true,
    });
    const lines = sqlite
      .prepare(
        `SELECT discount_allocated_satang
         FROM shop_order_items WHERE order_id = ?`,
      )
      .all(orderId) as { discount_allocated_satang: number }[];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.discount_allocated_satang).toBe(0);
    }
  });

  it("B6: createFromCart allocates the discount across lines, summing exactly", async () => {
    // 10001 satang across 50000 + 25000 — indivisible, so the
    // largest-remainder distribution must still sum exactly.
    const { orderId } = await createOrder({ discountSatang: 10001 });
    const lines = sqlite
      .prepare(
        `SELECT line_subtotal_satang, discount_allocated_satang
         FROM shop_order_items WHERE order_id = ?`,
      )
      .all(orderId) as Array<{
      line_subtotal_satang: number;
      discount_allocated_satang: number;
    }>;
    expect(lines).toHaveLength(2);
    const total = lines.reduce((s, l) => s + l.discount_allocated_satang, 0);
    expect(total).toBe(10001);
    for (const line of lines) {
      expect(line.discount_allocated_satang).toBeGreaterThan(0);
      expect(line.discount_allocated_satang).toBeLessThanOrEqual(
        line.line_subtotal_satang,
      );
    }
  });

  it("markPaid flips both axes once and emits order.paid exactly once", async () => {
    const { orderId } = await createOrder();
    events.length = 0;

    await svc.markPaid({ orderId, providerChargeId: "ch_1" });
    let row = orderRow(sqlite, orderId);
    expect(row.status).toBe("paid");
    expect(row.financial_status).toBe("paid");
    expect(row.fulfillment_status).toBe("unfulfilled");
    expect(events.map((e) => e.event)).toEqual(["order.paid"]);
    expect(events[0].payload).toMatchObject({
      orderId,
      financialStatus: "paid",
      fulfillmentStatus: "unfulfilled",
    });

    // Webhook retry: CAS loses → no state change, NO second event.
    await svc.markPaid({ orderId, providerChargeId: "ch_1" });
    row = orderRow(sqlite, orderId);
    expect(row.financial_status).toBe("paid");
    expect(events.map((e) => e.event)).toEqual(["order.paid"]);
  });

  it("markFulfilled / markDelivered walk the fulfillment axis and emit", async () => {
    const { orderId } = await createOrder();
    await svc.markPaid({ orderId, providerChargeId: "ch_1" });
    events.length = 0;

    // Cannot deliver before fulfilling — CAS predicate fails silently.
    await svc.markDelivered(orderId);
    expect(orderRow(sqlite, orderId).fulfillment_status).toBe("unfulfilled");
    expect(events).toHaveLength(0);

    await svc.markFulfilled(orderId);
    let row = orderRow(sqlite, orderId);
    expect(row.fulfillment_status).toBe("fulfilled");
    expect(row.status).toBe("fulfilled");
    expect(row.financial_status).toBe("paid");

    await svc.markDelivered(orderId);
    row = orderRow(sqlite, orderId);
    expect(row.fulfillment_status).toBe("delivered");
    expect(row.status).toBe("delivered");

    expect(events.map((e) => e.event)).toEqual([
      "order.fulfilled",
      "order.delivered",
    ]);
    expect(events[1].payload).toMatchObject({
      orderId,
      financialStatus: "paid",
      fulfillmentStatus: "delivered",
      status: "delivered",
    });

    // Replays are no-ops with no extra events.
    await svc.markFulfilled(orderId);
    await svc.markDelivered(orderId);
    expect(events).toHaveLength(2);
  });

  it("markCancelled sets the financial axis and emits order.cancelled", async () => {
    const { orderId } = await createOrder();
    events.length = 0;
    await svc.markCancelled({ orderId });
    const row = orderRow(sqlite, orderId);
    expect(row.status).toBe("cancelled");
    expect(row.financial_status).toBe("cancelled");
    expect(events.map((e) => e.event)).toEqual(["order.cancelled"]);

    // Idempotent — terminal state, no re-emission.
    await svc.markCancelled({ orderId });
    expect(events).toHaveLength(1);
  });

  it("'paid + partially refunded + fulfilled' is representable (#109 acceptance)", async () => {
    const { orderId } = await createOrder();
    await svc.markPaid({ orderId, providerChargeId: "ch_1" });
    await svc.recordRefund({
      orderId,
      amountSatang: 10000,
      kind: "refund_partial",
      idempotencyKey: "k-1",
    });
    // A partially refunded order can still ship.
    await svc.markFulfilled(orderId);
    const row = orderRow(sqlite, orderId);
    expect(row.financial_status).toBe("partially_refunded");
    expect(row.fulfillment_status).toBe("fulfilled");
    // Legacy projection keeps presenting fulfillment progress.
    expect(row.status).toBe("fulfilled");

    const refundEvent = events.find((e) => e.event === "order.refunded");
    expect(refundEvent?.payload).toMatchObject({
      financialStatus: "partially_refunded",
      refundAmountSatang: 10000,
      refundedTotalSatang: 10000,
      refundKind: "refund_partial",
    });
  });

  it("emits nothing when constructed without an emitter (routes not yet wired)", async () => {
    const bare = new OrderService(d1);
    seedVariant(sqlite, "var-1");
    seedCheckoutCart(sqlite, "cart-1", {
      items: [{ variantId: "var-1", qty: 1 }],
    });
    const { orderId } = await bare.createFromCart({
      cartId: "cart-1",
      email: "buyer@example.com",
      providerName: "beam",
    });
    await bare.markPaid({ orderId, providerChargeId: "ch_1" });
    expect(orderRow(sqlite, orderId).financial_status).toBe("paid");
  });

  it("a throwing emitter never fails the order write", async () => {
    const noisy = new OrderService(d1, {
      emitEvent: () => {
        throw new Error("subscriber exploded");
      },
    });
    seedVariant(sqlite, "var-1");
    seedCheckoutCart(sqlite, "cart-1", {
      items: [{ variantId: "var-1", qty: 1 }],
    });
    const { orderId } = await noisy.createFromCart({
      cartId: "cart-1",
      email: "buyer@example.com",
      providerName: "beam",
    });
    await noisy.markPaid({ orderId, providerChargeId: "ch_1" });
    expect(orderRow(sqlite, orderId).financial_status).toBe("paid");
  });
});
