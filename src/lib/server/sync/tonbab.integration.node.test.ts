/**
 * #160 Phase E-1 — Tonbab commerce sync, inbound half.
 *
 * Same better-sqlite3 + migration-replay harness as the shop plugin's
 * integration tests: every test runs against the REAL migrations,
 * 0030 included, so the partial UNIQUE index and sync_log are the
 * production DDL, not a hand-mocked schema.
 */
import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderService } from "$plugins/shop/order-service";
import {
  deductVariantOnHand,
  restoreVariantOnHand,
} from "$plugins/shop/inventory";
import {
  isStrictBase64,
  MAX_ITEMS_PER_ORDER,
  MAX_ORDERS_PER_BATCH,
  parseTonbabSyncBody,
  processTonbabSync,
  verifyTonbabSignature,
  type TonbabSyncBody,
} from "./tonbab";
import { POST } from "../../../routes/api/sync/tonbab/+server";

const MIGRATIONS_DIR = new URL("../../../../drizzle", import.meta.url).pathname;

function applyMigrations(db: Database.Database) {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
}

/** Minimal D1Database shim over better-sqlite3 (same as shop tests). */
function d1Shim(db: Database.Database): D1Database {
  const run = (sql: string, params: unknown[]) => {
    const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const bound =
      numbered.length > 0 ? numbered.map((n) => params[n - 1]) : params;
    // Emulate D1's 100-bound-parameter ceiling. better-sqlite3's own
    // limit is far higher, so without this the chunking fixes (order
    // items ≤9 rows/insert, SKU lookups ≤90/inArray) would be
    // untestable — an unchunked statement would silently pass here and
    // fail in production.
    if (bound.length > 100) {
      throw new Error(
        `D1_ERROR: too many SQL variables (${bound.length} > 100)`,
      );
    }
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

type RecordedEvent = { event: string; payload: Record<string, unknown> };
let events: RecordedEvent[];

function orderSvc(): OrderService {
  return new OrderService(d1, {
    emitEvent: (event, payload) => events.push({ event, payload }),
  });
}

function seedVariant(id: string, sku: string, onHand = 100) {
  sqlite
    .prepare(
      `INSERT INTO shop_products (id, slug, status, created_at, updated_at)
       VALUES (?, ?, 'active', '2026-08-01', '2026-08-01')`,
    )
    .run(`prod-${id}`, `prod-${id}`);
  sqlite
    .prepare(
      `INSERT INTO shop_product_variants
         (id, product_id, sku, status, title_cached, price_satang)
       VALUES (?, ?, ?, 'active', 'Default', 25000)`,
    )
    .run(id, `prod-${id}`, sku);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_items (id, variant_id, tracked)
       VALUES (?, ?, 1)`,
    )
    .run(`inv-${id}`, id);
  sqlite
    .prepare(
      `INSERT INTO shop_inventory_levels (item_id, location_id, on_hand, reserved)
       VALUES (?, 'default', ?, 0)`,
    )
    .run(`inv-${id}`, onHand);
}

function inventoryLevel(variantId: string) {
  return sqlite
    .prepare(
      `SELECT on_hand AS onHand, reserved FROM shop_inventory_levels
       WHERE item_id = (SELECT id FROM shop_inventory_items WHERE variant_id = ?)`,
    )
    .get(variantId) as { onHand: number; reserved: number };
}

function syncLogRows() {
  return sqlite.prepare(`SELECT * FROM sync_log ORDER BY rowid`).all() as Array<
    Record<string, unknown>
  >;
}

const SECRET = Buffer.from("tonbab-pairing-secret").toString("base64");

function sign(body: string, secret = SECRET): string {
  // Mirror of the documented computation: HMAC-SHA256 over raw body,
  // base64-DECODED key, base64 digest.
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(body)
    .digest("base64");
}

/** Module-level route caller (the audit-regression blocks use this). */
async function postSync(body: string, signature: string) {
  const request = new Request("https://shop.example.com/api/sync/tonbab", {
    method: "POST",
    headers: new Headers({ "x-tonbab-signature": signature }),
    body,
  });
  return POST({
    request,
    platform: { env: { DB: d1, TONBAB_WEBHOOK_SECRET: SECRET } },
    locals: { content: {} },
  } as unknown as Parameters<typeof POST>[0]);
}

function upsertBody(
  externalId = "TB-1",
  overrides: Record<string, unknown> = {},
): TonbabSyncBody {
  return {
    source: "tonbab",
    orders: [
      {
        externalId,
        action: "upsert",
        paid: true,
        placedAt: "2026-08-12T09:30:00.000Z",
        items: [{ sku: "SKU-A", quantity: 2, priceSatang: 45000 }],
        totals: { subtotalSatang: 90000, taxSatang: 6300, totalSatang: 96300 },
        ...overrides,
      },
    ],
  } as TonbabSyncBody;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  d1 = d1Shim(sqlite);
  events = [];
});

// ─── Migration 0030 ─────────────────────────────────────────

describe("migration 0030", () => {
  it("adds external identity columns, the partial unique index, and sync_log", () => {
    const cols = sqlite
      .prepare(`PRAGMA table_info(shop_orders)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("external_source");
    expect(names).toContain("external_id");

    // sync_log exists with the expected shape.
    const syncCols = sqlite
      .prepare(`PRAGMA table_info(sync_log)`)
      .all() as Array<{ name: string }>;
    expect(syncCols.map((c) => c.name).sort()).toEqual([
      "action",
      "created_at",
      "detail",
      "direction",
      "external_id",
      "id",
      "result",
      "source",
    ]);
  });

  it("partial unique index rejects duplicate (source, external_id) but ignores native orders", () => {
    const insert = (id: string, src: string | null, ext: string | null) =>
      sqlite
        .prepare(
          `INSERT INTO shop_orders
             (id, order_number, email, status, financial_status,
              fulfillment_status, channel, subtotal_satang, total_satang,
              created_at, updated_at, external_source, external_id)
           VALUES (?, ?, 'x@y.z', 'paid', 'paid', 'unfulfilled', 'tonbab_pos',
                   100, 100, '2026-08-12', '2026-08-12', ?, ?)`,
        )
        .run(id, `KHP-2026-${id}`, src, ext);

    insert("00001", "tonbab", "TB-1");
    expect(() => insert("00002", "tonbab", "TB-1")).toThrow(/UNIQUE/);
    // Native orders: both NULL, arbitrarily many.
    insert("00003", null, null);
    insert("00004", null, null);
  });
});

// ─── Signature verification ─────────────────────────────────

describe("verifyTonbabSignature", () => {
  const body = JSON.stringify({ source: "tonbab", orders: [] });

  it("accepts a correct signature (and a sha256= prefixed one)", async () => {
    const sig = sign(body);
    expect((await verifyTonbabSignature(SECRET, body, sig)).ok).toBe(true);
    expect(
      (await verifyTonbabSignature(SECRET, body, `sha256=${sig}`)).ok,
    ).toBe(true);
  });

  it("rejects a missing signature", async () => {
    const res = await verifyTonbabSignature(SECRET, body, null);
    expect(res).toEqual({ ok: false, code: "MISSING_SIGNATURE" });
    const blank = await verifyTonbabSignature(SECRET, body, "   ");
    expect(blank).toEqual({ ok: false, code: "MISSING_SIGNATURE" });
  });

  it("rejects a wrong signature and a signature over a different body", async () => {
    expect(await verifyTonbabSignature(SECRET, body, "bm90LXJlYWw=")).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
    const other = sign(JSON.stringify({ tampered: true }));
    expect((await verifyTonbabSignature(SECRET, body, other)).ok).toBe(false);
  });
});

// ─── Route-level auth semantics ─────────────────────────────

describe("POST /api/sync/tonbab", () => {
  const callRoute = async (opts: {
    body: string;
    signature?: string | null;
    secretConfigured?: boolean;
  }) => {
    const env: Record<string, unknown> = { DB: d1 };
    if (opts.secretConfigured !== false) env.TONBAB_WEBHOOK_SECRET = SECRET;
    const headers = new Headers();
    if (opts.signature) headers.set("x-tonbab-signature", opts.signature);
    const request = new Request("https://shop.example.com/api/sync/tonbab", {
      method: "POST",
      headers,
      body: opts.body,
    });
    // Route touches locals.content only inside the (fire-and-forget)
    // event dispatcher; a bare object is fine here.
    const res = await POST({
      request,
      platform: { env },
      locals: { content: {} },
    } as unknown as Parameters<typeof POST>[0]);
    return {
      status: res.status,
      json: () => res.json() as Promise<Record<string, unknown>>,
    };
  };

  it("503 when TONBAB_WEBHOOK_SECRET is unconfigured", async () => {
    const body = JSON.stringify(upsertBody());
    const res = await callRoute({
      body,
      signature: sign(body),
      secretConfigured: false,
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("SYNC_NOT_CONFIGURED");
  });

  it("401 on missing and on invalid signature", async () => {
    const body = JSON.stringify(upsertBody());
    const missing = await callRoute({ body, signature: null });
    expect(missing.status).toBe(401);
    expect((await missing.json()).code).toBe("MISSING_SIGNATURE");

    const bad = await callRoute({ body, signature: "bm90LXJlYWw=" });
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe("INVALID_SIGNATURE");
  });

  it("400 on signed-but-malformed envelope", async () => {
    const notJson = "{nope";
    const res = await callRoute({ body: notJson, signature: sign(notJson) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_JSON");

    const wrongSource = JSON.stringify({ source: "beam", orders: [] });
    const res2 = await callRoute({
      body: wrongSource,
      signature: sign(wrongSource),
    });
    expect(res2.status).toBe(400);
    expect((await res2.json()).code).toBe("MALFORMED_PAYLOAD");
  });

  it("200 with per-order results on a verified batch", async () => {
    seedVariant("var-1", "SKU-A");
    const body = JSON.stringify(upsertBody());
    const res = await callRoute({ body, signature: sign(body) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      results: Array<{ ok: boolean; orderNumber?: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.results).toHaveLength(1);
    expect(json.results[0].ok).toBe(true);
    expect(json.results[0].orderNumber).toMatch(/^KHP-\d{4}-\d{5}$/);
  });
});

// ─── POS upsert ─────────────────────────────────────────────

describe("upsert (POS sale)", () => {
  it("creates a paid tonbab_pos order with supplied totals, deducts on-hand only, logs timeline + sync_log, emits nothing", async () => {
    seedVariant("var-1", "SKU-A");
    const results = await processTonbabSync(d1, orderSvc(), upsertBody("TB-1"));
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].replayed).toBe(false);

    const order = sqlite
      .prepare(`SELECT * FROM shop_orders WHERE external_id = 'TB-1'`)
      .get() as Record<string, unknown>;
    expect(order.channel).toBe("tonbab_pos");
    expect(order.external_source).toBe("tonbab");
    expect(order.financial_status).toBe("paid");
    expect(order.status).toBe("paid");
    expect(order.paid_at).toBe("2026-08-12T09:30:00.000Z");
    // Totals AS SUPPLIED — 90000 + 6300, never recomputed from lines.
    expect(order.subtotal_satang).toBe(90000);
    expect(order.tax_satang).toBe(6300);
    expect(order.total_satang).toBe(96300);

    const items = sqlite
      .prepare(`SELECT * FROM shop_order_items WHERE order_id = ?`)
      .all(order.id) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].sku_snapshot).toBe("SKU-A");
    expect(items[0].quantity).toBe(2);
    expect(items[0].price_snapshot_satang).toBe(45000);

    // On-hand deducted directly; reserved untouched (POS stock was
    // never reserved).
    expect(inventoryLevel("var-1")).toEqual({ onHand: 98, reserved: 0 });

    // Timeline carries a sync event.
    const timeline = sqlite
      .prepare(
        `SELECT kind, actor_email FROM shop_order_events WHERE order_id = ?`,
      )
      .all(order.id) as Array<{ kind: string; actor_email: string | null }>;
    expect(timeline.map((t) => t.kind)).toContain("sync");
    expect(timeline.find((t) => t.kind === "sync")?.actor_email).toBe(
      "tonbab-sync",
    );

    // Echo-loop guard: NO order.created (nor any other event) emitted
    // for a POS-originated creation.
    expect(events).toEqual([]);

    // sync_log audit row.
    const log = syncLogRows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      source: "tonbab",
      direction: "inbound",
      external_id: "TB-1",
      action: "upsert",
      result: "created",
    });
  });

  it("replays the same (source, externalId) idempotently — no dup order, no second decrement", async () => {
    seedVariant("var-1", "SKU-A");
    const first = await processTonbabSync(d1, orderSvc(), upsertBody("TB-1"));
    const second = await processTonbabSync(d1, orderSvc(), upsertBody("TB-1"));

    expect(second[0].ok).toBe(true);
    expect(second[0].replayed).toBe(true);
    expect(second[0].orderId).toBe(first[0].orderId);

    const count = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM shop_orders WHERE external_id = 'TB-1'`,
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
    // Inventory deducted exactly once.
    expect(inventoryLevel("var-1").onHand).toBe(98);
    // Both attempts audited.
    expect(syncLogRows().map((r) => r.result)).toEqual(["created", "replayed"]);
  });

  it("unknown SKU fails that order only — the batch continues", async () => {
    seedVariant("var-1", "SKU-A");
    const body: TonbabSyncBody = {
      source: "tonbab",
      orders: [
        {
          externalId: "TB-BAD",
          action: "upsert",
          items: [{ sku: "NOPE-123", quantity: 1, priceSatang: 1000 }],
          totals: { subtotalSatang: 1000, totalSatang: 1000 },
        },
        {
          externalId: "TB-GOOD",
          action: "upsert",
          items: [{ sku: "SKU-A", quantity: 1, priceSatang: 25000 }],
          totals: { subtotalSatang: 25000, totalSatang: 25000 },
        },
      ],
    };
    const results = await processTonbabSync(d1, orderSvc(), body);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/Unknown SKU.*NOPE-123/);
    expect(results[1].ok).toBe(true);

    const orders = sqlite
      .prepare(`SELECT external_id FROM shop_orders`)
      .all() as Array<{ external_id: string }>;
    expect(orders.map((o) => o.external_id)).toEqual(["TB-GOOD"]);
    expect(syncLogRows().map((r) => r.result)).toEqual(["error", "created"]);
  });

  it("imports a 12-line receipt fully — items insert is chunked under D1's 100-bind ceiling", async () => {
    // 12 items × 10 columns = 120 binds unchunked, which the shim
    // rejects like production D1. Pre-fix this committed the order
    // header, lost every line item, and left inventory untouched.
    const items = Array.from({ length: 12 }, (_, i) => {
      seedVariant(`var-${i}`, `SKU-${i}`);
      return { sku: `SKU-${i}`, quantity: 1, priceSatang: 1000 };
    });
    const results = await processTonbabSync(d1, orderSvc(), {
      source: "tonbab",
      orders: [
        {
          externalId: "TB-BIG",
          action: "upsert",
          items,
          totals: { subtotalSatang: 12000, totalSatang: 12000 },
        },
      ],
    } as TonbabSyncBody);
    expect(results[0].ok).toBe(true);
    expect(results[0].replayed).toBe(false);

    const rows = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM shop_order_items
         WHERE order_id = (SELECT id FROM shop_orders WHERE external_id = 'TB-BIG')`,
      )
      .get() as { n: number };
    expect(rows.n).toBe(12);
    // Every line's inventory was deducted.
    for (let i = 0; i < 12; i++) {
      expect(inventoryLevel(`var-${i}`).onHand).toBe(99);
    }
  });

  it("resolves a 95-distinct-SKU receipt — SKU lookup is chunked under the bind ceiling", async () => {
    const items = Array.from({ length: 95 }, (_, i) => {
      seedVariant(`v95-${i}`, `SKU95-${i}`);
      return { sku: `SKU95-${i}`, quantity: 1, priceSatang: 100 };
    });
    const results = await processTonbabSync(d1, orderSvc(), {
      source: "tonbab",
      orders: [
        {
          externalId: "TB-WIDE",
          action: "upsert",
          items,
          totals: { subtotalSatang: 9500, totalSatang: 9500 },
        },
      ],
    } as TonbabSyncBody);
    expect(results[0].ok).toBe(true);
    const rows = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM shop_order_items
         WHERE order_id = (SELECT id FROM shop_orders WHERE external_id = 'TB-WIDE')`,
      )
      .get() as { n: number };
    expect(rows.n).toBe(95);
  });

  it("repairs a half-created order on replay: items restored, inventory deducted once", async () => {
    seedVariant("var-1", "SKU-A");
    // Simulate the pre-fix crash state: header row committed, items
    // insert died — a permanent order with totals but ZERO items and
    // no inventory deduction.
    sqlite
      .prepare(
        `INSERT INTO shop_orders
           (id, order_number, email, status, financial_status,
            fulfillment_status, channel, subtotal_satang, tax_satang,
            total_satang, created_at, updated_at, paid_at,
            external_source, external_id)
         VALUES ('husk-1', 'KHP-2026-00001', 'pos@tonbab.sync', 'paid',
                 'paid', 'unfulfilled', 'tonbab_pos', 90000, 6300, 96300,
                 '2026-08-12', '2026-08-12', '2026-08-12', 'tonbab', 'TB-1')`,
      )
      .run();

    const results = await processTonbabSync(d1, orderSvc(), upsertBody("TB-1"));
    expect(results[0]).toMatchObject({
      ok: true,
      orderId: "husk-1",
      replayed: true,
    });

    // Item rows repaired from the replayed payload.
    const items = sqlite
      .prepare(`SELECT * FROM shop_order_items WHERE order_id = 'husk-1'`)
      .all() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].sku_snapshot).toBe("SKU-A");
    // Inventory deduction ran for the repair (it never ran originally).
    expect(inventoryLevel("var-1").onHand).toBe(98);

    // A SECOND replay is now a plain no-op: no dup items, no second
    // deduction.
    const again = await processTonbabSync(d1, orderSvc(), upsertBody("TB-1"));
    expect(again[0]).toMatchObject({ ok: true, replayed: true });
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM shop_order_items WHERE order_id = 'husk-1'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(inventoryLevel("var-1").onHand).toBe(98);
  });

  it("rejects non-integer or negative money fields per order — batch continues", async () => {
    seedVariant("var-1", "SKU-A");
    const results = await processTonbabSync(d1, orderSvc(), {
      source: "tonbab",
      orders: [
        {
          externalId: "TB-FLOAT",
          action: "upsert",
          items: [{ sku: "SKU-A", quantity: 1, priceSatang: 250.5 }],
          totals: { subtotalSatang: 250, totalSatang: 250 },
        },
        {
          externalId: "TB-NEG",
          action: "upsert",
          items: [{ sku: "SKU-A", quantity: 1, priceSatang: 250 }],
          totals: {
            subtotalSatang: 250,
            discountSatang: -50,
            totalSatang: 300,
          },
        },
        {
          externalId: "TB-OK",
          action: "upsert",
          items: [{ sku: "SKU-A", quantity: 1, priceSatang: 25000 }],
          totals: { subtotalSatang: 25000, totalSatang: 25000 },
        },
      ],
    } as TonbabSyncBody);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/priceSatang.*SKU-A/);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toMatch(/totals\.discountSatang/);
    expect(results[2].ok).toBe(true);
    // Only the valid order landed; the invalid ones stored nothing.
    const orders = sqlite
      .prepare(`SELECT external_id FROM shop_orders`)
      .all() as Array<{ external_id: string }>;
    expect(orders.map((o) => o.external_id)).toEqual(["TB-OK"]);
  });
});

// ─── Transitions ────────────────────────────────────────────

describe("transitions", () => {
  async function seedPosOrder(externalId = "TB-1") {
    seedVariant("var-1", "SKU-A");
    const results = await processTonbabSync(
      d1,
      orderSvc(),
      upsertBody(externalId),
    );
    expect(results[0].ok).toBe(true);
    return results[0].orderId!;
  }

  const transition = (
    to: "fulfilled" | "delivered" | "cancelled" | "refunded",
    extra: Record<string, unknown> = {},
  ): TonbabSyncBody =>
    ({
      source: "tonbab",
      orders: [{ externalId: "TB-1", action: "transition", to, ...extra }],
    }) as TonbabSyncBody;

  it("fulfil + deliver run through the existing service transitions (events with channel, timeline, actor)", async () => {
    const orderId = await seedPosOrder();
    const svc = orderSvc();

    const f = await processTonbabSync(d1, svc, transition("fulfilled"));
    expect(f[0]).toMatchObject({ ok: true, orderId });
    const de = await processTonbabSync(d1, svc, transition("delivered"));
    expect(de[0]).toMatchObject({ ok: true, orderId });

    // Lifecycle events DID fire (unlike creation) and carry channel so
    // Tonbab can self-filter its own orders.
    expect(events.map((e) => e.event)).toEqual([
      "order.fulfilled",
      "order.delivered",
    ]);
    for (const e of events) {
      expect(e.payload.channel).toBe("tonbab_pos");
    }

    const timeline = sqlite
      .prepare(
        `SELECT kind, actor_email FROM shop_order_events
         WHERE order_id = ? ORDER BY created_at, id`,
      )
      .all(orderId) as Array<{ kind: string; actor_email: string | null }>;
    const kinds = timeline.map((t) => t.kind);
    expect(kinds).toContain("fulfilled");
    expect(kinds).toContain("delivered");
    expect(timeline.find((t) => t.kind === "fulfilled")?.actor_email).toBe(
      "tonbab-sync",
    );
  });

  it("delivered on an unfulfilled order walks fulfil → deliver", async () => {
    const orderId = await seedPosOrder();
    const res = await processTonbabSync(
      d1,
      orderSvc(),
      transition("delivered"),
    );
    expect(res[0].ok).toBe(true);
    const order = sqlite
      .prepare(
        `SELECT fulfillment_status, status FROM shop_orders WHERE id = ?`,
      )
      .get(orderId) as { fulfillment_status: string; status: string };
    expect(order.fulfillment_status).toBe("delivered");
    expect(order.status).toBe("delivered");
  });

  it("refund records through the ledger, dedupes on tonbab:<orderId>:<seq>", async () => {
    const orderId = await seedPosOrder();
    const refund = () =>
      processTonbabSync(
        d1,
        orderSvc(),
        transition("refunded", {
          refund: { amountSatang: 96300, seq: 1, reason: "Counter return" },
        }),
      );

    const first = await refund();
    expect(first[0]).toMatchObject({ ok: true, replayed: false });

    const replay = await refund();
    expect(replay[0].ok).toBe(true);

    // Exactly ONE ledger row despite two deliveries. The key uses the
    // RESOLVED internal order id, never the join key.
    const ledger = sqlite
      .prepare(
        `SELECT amount_satang, idempotency_key FROM shop_order_adjustments
         WHERE order_id = ?`,
      )
      .all(orderId) as Array<{
      amount_satang: number;
      idempotency_key: string;
    }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount_satang).toBe(-96300);
    expect(ledger[0].idempotency_key).toBe(`tonbab:${orderId}:1`);

    const order = sqlite
      .prepare(`SELECT financial_status FROM shop_orders WHERE id = ?`)
      .get(orderId) as { financial_status: string };
    expect(order.financial_status).toBe("refunded");
  });

  it("refund is idempotent on repeated externalId deliveries and records exactly one ledger row", async () => {
    const orderId = await seedPosOrder();

    const first = await processTonbabSync(
      d1,
      orderSvc(),
      transition("refunded", { refund: { amountSatang: 40000, seq: 1 } }),
    );
    expect(first[0]).toMatchObject({ ok: true, replayed: false });

    // At-least-once redelivery of the SAME refund.
    const retry = await processTonbabSync(
      d1,
      orderSvc(),
      transition("refunded", { refund: { amountSatang: 40000, seq: 1 } }),
    );
    expect(retry[0]).toMatchObject({ ok: true, replayed: true });

    const ledger = sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM shop_order_adjustments WHERE order_id = ?`,
      )
      .get(orderId) as { n: number };
    expect(ledger.n).toBe(1);
  });

  it("cancelling a paid POS order restores on-hand and never touches web reservations", async () => {
    const orderId = await seedPosOrder(); // imports 2 units: 100 → 98
    expect(inventoryLevel("var-1")).toEqual({ onHand: 98, reserved: 0 });
    // A live WEB customer holds 5 reserved units of the same variant.
    sqlite
      .prepare(
        `UPDATE shop_inventory_levels SET reserved = 5
         WHERE item_id = 'inv-var-1'`,
      )
      .run();

    const res = await processTonbabSync(
      d1,
      orderSvc(),
      transition("cancelled"),
    );
    expect(res[0]).toMatchObject({ ok: true, orderId });

    // On-hand restored (98 → 100); the web customer's reservation is
    // untouched — pre-fix releaseVariant() stole it (reserved 5 → 3).
    expect(inventoryLevel("var-1")).toEqual({ onHand: 100, reserved: 5 });
    const order = sqlite
      .prepare(`SELECT financial_status FROM shop_orders WHERE id = ?`)
      .get(orderId) as { financial_status: string };
    expect(order.financial_status).toBe("cancelled");
  });

  it("admin-UI cancel (direct markCancelled) of a POS order behaves identically", async () => {
    const orderId = await seedPosOrder();
    sqlite
      .prepare(
        `UPDATE shop_inventory_levels SET reserved = 5
         WHERE item_id = 'inv-var-1'`,
      )
      .run();
    // Same call the admin route makes — no sync path involved. The
    // unwind is keyed on the ORDER's externalSource/channel.
    await orderSvc().markCancelled({ orderId });
    expect(inventoryLevel("var-1")).toEqual({ onHand: 100, reserved: 5 });
  });

  it("cancelling a native web order still releases its reservation (regression guard)", async () => {
    seedVariant("var-web", "SKU-WEB");
    sqlite
      .prepare(
        `INSERT INTO shop_orders
           (id, order_number, email, status, financial_status,
            fulfillment_status, channel, subtotal_satang, total_satang,
            created_at, updated_at)
         VALUES ('web-1', 'KHP-2026-00900', 'w@x.y', 'pending', 'pending',
                 'unfulfilled', 'online_store', 25000, 25000,
                 '2026-08-12', '2026-08-12')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO shop_order_items
           (id, order_id, variant_id, quantity, title_snapshot,
            price_snapshot_satang, line_subtotal_satang)
         VALUES ('li-web', 'web-1', 'var-web', 2, 'Default', 12500, 25000)`,
      )
      .run();
    sqlite
      .prepare(
        `UPDATE shop_inventory_levels SET reserved = 2
         WHERE item_id = 'inv-var-web'`,
      )
      .run();

    await orderSvc().markCancelled({ orderId: "web-1" });
    // Native path unchanged: reservation released, on-hand untouched.
    expect(inventoryLevel("var-web")).toEqual({ onHand: 100, reserved: 0 });
  });

  it("LWW: transition against an already-terminal axis is skipped, not an error", async () => {
    await seedPosOrder();
    await processTonbabSync(
      d1,
      orderSvc(),
      transition("refunded", { refund: { amountSatang: 96300, seq: 1 } }),
    );

    // Cancel after full refund → financial axis is terminal.
    const cancel = await processTonbabSync(
      d1,
      orderSvc(),
      transition("cancelled"),
    );
    expect(cancel[0]).toMatchObject({ ok: true, skipped: true });
    expect(cancel[0].reason).toMatch(/refunded/);

    // A NEW refund (seq 2) against an exhausted balance is NOT a
    // skip — audit MAJOR 7b. It is money Tonbab believes it returned
    // that Khao Pad's ledger cannot account for, so it must surface as
    // a per-order error instead of being acknowledged as success.
    const again = await processTonbabSync(
      d1,
      orderSvc(),
      transition("refunded", { refund: { amountSatang: 96300, seq: 2 } }),
    );
    expect(again[0]).toMatchObject({ ok: false });
    expect(again[0].error).toMatch(/already fully refunded/);

    expect(
      syncLogRows()
        .filter((r) => r.result === "skipped")
        .map((r) => r.action),
    ).toEqual(["transition:cancelled"]);
  });

  it("locates Khao Pad-originated orders by orderNumber and errors cleanly on unknown orders", async () => {
    const orderId = await seedPosOrder("TB-OTHER");
    const orderNumber = (
      sqlite
        .prepare(`SELECT order_number AS n FROM shop_orders WHERE id = ?`)
        .get(orderId) as { n: string }
    ).n;

    const byNumber = await processTonbabSync(d1, orderSvc(), {
      source: "tonbab",
      orders: [{ orderNumber, action: "transition", to: "fulfilled" }],
    } as TonbabSyncBody);
    expect(byNumber[0]).toMatchObject({ ok: true, orderId });

    const missing = await processTonbabSync(d1, orderSvc(), {
      source: "tonbab",
      orders: [
        { externalId: "TB-NOPE", action: "transition", to: "fulfilled" },
      ],
    } as TonbabSyncBody);
    expect(missing[0]).toMatchObject({ ok: false, error: "Order not found" });
  });
});

// ─── Inventory primitives (Phase E additions) ───────────────

describe("deductVariantOnHand / restoreVariantOnHand", () => {
  it("warns on clamp-to-zero, same contract as commitVariantSale", async () => {
    seedVariant("var-low", "SKU-LOW", 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const after = await deductVariantOnHand(d1, "var-low", 3);
      expect(after.onHand).toBe(0); // clamped, books follow reality
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("deductVariantOnHand silently clamps on_hand"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("restore adds on-hand back without touching reserved", async () => {
    seedVariant("var-r", "SKU-R", 10);
    sqlite
      .prepare(
        `UPDATE shop_inventory_levels SET reserved = 4 WHERE item_id = 'inv-var-r'`,
      )
      .run();
    const after = await restoreVariantOnHand(d1, "var-r", 2);
    expect(after).toEqual({ onHand: 12, reserved: 4 });
  });
});

// ─── Envelope parsing ───────────────────────────────────────

describe("parseTonbabSyncBody", () => {
  it("accepts the documented envelope and rejects non-tonbab sources", () => {
    expect(
      parseTonbabSyncBody(JSON.stringify({ source: "tonbab", orders: [] })).ok,
    ).toBe(true);
    expect(parseTonbabSyncBody("[]").ok).toBe(false);
    expect(
      parseTonbabSyncBody(JSON.stringify({ source: "x", orders: [] })).ok,
    ).toBe(false);
    expect(
      parseTonbabSyncBody(JSON.stringify({ source: "tonbab", orders: {} })).ok,
    ).toBe(false);
  });
});

// ─── v4.0.1 audit regressions ───────────────────────────────
//
// Every test below FAILS on the pre-fix code. Each is annotated with
// the audit finding it pins.

describe("audit C1 — partial-receipt repair (not just zero items)", () => {
  /** A 12-line receipt: crosses the CHUNK=9 items-insert boundary. */
  function receipt(externalId = "TB-12"): TonbabSyncBody {
    return {
      source: "tonbab",
      orders: [
        {
          externalId,
          action: "upsert",
          paid: true,
          items: Array.from({ length: 12 }, (_, i) => ({
            sku: `SKU-${i}`,
            quantity: 1,
            priceSatang: 1000,
          })),
          totals: { subtotalSatang: 12000, totalSatang: 12000 },
        },
      ],
    } as TonbabSyncBody;
  }

  function seed12() {
    for (let i = 0; i < 12; i++) seedVariant(`var-${i}`, `SKU-${i}`, 100);
  }

  it("repairs a receipt stuck at 9 of 12 lines and deducts inventory exactly once", async () => {
    seed12();
    // Reproduce the real crash shape: header + chunk 1 (9 rows)
    // committed, chunk 2 died. Pre-fix, replayExternalOrder counted
    // 9 > 0 and returned repaired:false forever — the order kept 9 of
    // 12 lines while total_satang described all 12, and NO inventory
    // was ever deducted.
    sqlite
      .prepare(
        `INSERT INTO shop_orders
           (id, order_number, email, status, financial_status,
            fulfillment_status, channel, subtotal_satang, total_satang,
            created_at, updated_at, paid_at, external_source, external_id)
         VALUES ('partial-1', 'KHP-2026-00001', 'pos@tonbab.sync', 'paid',
                 'paid', 'unfulfilled', 'tonbab_pos', 12000, 12000,
                 '2026-08-12', '2026-08-12', '2026-08-12',
                 'tonbab', 'TB-12')`,
      )
      .run();
    for (let i = 0; i < 9; i++) {
      sqlite
        .prepare(
          `INSERT INTO shop_order_items
             (id, order_id, variant_id, quantity, title_snapshot,
              sku_snapshot, price_snapshot_satang, line_subtotal_satang,
              line_tax_satang, discount_allocated_satang)
           VALUES (?, 'partial-1', ?, 1, 'Default', ?, 1000, 1000, 0, 0)`,
        )
        .run(`ext:partial-1:${i}`, `var-${i}`, `SKU-${i}`);
    }

    const res = await processTonbabSync(d1, orderSvc(), receipt());
    expect(res[0]).toMatchObject({ ok: true, orderId: "partial-1" });

    // All 12 lines now present — and NOT 21 (the 9 existing rows were
    // not re-inserted; deterministic ids made the re-insert a no-op).
    const rows = sqlite
      .prepare(`SELECT id FROM shop_order_items WHERE order_id = 'partial-1'`)
      .all() as Array<{ id: string }>;
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.id)).size).toBe(12);

    // Inventory deducted once per line.
    for (let i = 0; i < 12; i++) {
      expect(inventoryLevel(`var-${i}`).onHand).toBe(99);
    }

    // A further replay is a plain no-op.
    await processTonbabSync(d1, orderSvc(), receipt());
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM shop_order_items WHERE order_id = 'partial-1'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(12);
    expect(inventoryLevel("var-0").onHand).toBe(99);
  });

  it("external item ids are deterministic from (orderId, lineIndex)", async () => {
    seed12();
    const res = await processTonbabSync(d1, orderSvc(), receipt("TB-DET"));
    const orderId = res[0].orderId!;
    const ids = (
      sqlite
        .prepare(
          `SELECT id FROM shop_order_items WHERE order_id = ? ORDER BY id`,
        )
        .all(orderId) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(
      Array.from({ length: 12 }, (_, i) => `ext:${orderId}:${i}`).sort(),
    );
  });
});

describe("audit C2 — concurrent replays must not double-deduct", () => {
  it("two simultaneous deliveries of the same partial order repair once", async () => {
    for (let i = 0; i < 12; i++) seedVariant(`var-${i}`, `SKU-${i}`, 100);
    sqlite
      .prepare(
        `INSERT INTO shop_orders
           (id, order_number, email, status, financial_status,
            fulfillment_status, channel, subtotal_satang, total_satang,
            created_at, updated_at, paid_at, external_source, external_id)
         VALUES ('race-1', 'KHP-2026-00001', 'pos@tonbab.sync', 'paid',
                 'paid', 'unfulfilled', 'tonbab_pos', 12000, 12000,
                 '2026-08-12', '2026-08-12', '2026-08-12',
                 'tonbab', 'TB-RACE')`,
      )
      .run();

    const body = () =>
      ({
        source: "tonbab",
        orders: [
          {
            externalId: "TB-RACE",
            action: "upsert",
            paid: true,
            items: Array.from({ length: 12 }, (_, i) => ({
              sku: `SKU-${i}`,
              quantity: 1,
              priceSatang: 1000,
            })),
            totals: { subtotalSatang: 12000, totalSatang: 12000 },
          },
        ],
      }) as TonbabSyncBody;

    // Both writers observe the SAME pre-insert state (count 0) before
    // either repairs — the exact interleaving the audit describes.
    // The header CAS lets only one through.
    const [a, b] = await Promise.all([
      processTonbabSync(d1, orderSvc(), body()),
      processTonbabSync(d1, orderSvc(), body()),
    ]);
    expect(a[0].ok).toBe(true);
    expect(b[0].ok).toBe(true);

    // 12 rows, not 24.
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM shop_order_items WHERE order_id = 'race-1'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(12);
    // Deducted once, not twice.
    for (let i = 0; i < 12; i++) {
      expect(inventoryLevel(`var-${i}`).onHand).toBe(99);
    }
  });
});

describe("audit MAJOR 6 — order-number join key is restricted", () => {
  async function seedNativeWebOrder(): Promise<string> {
    seedVariant("var-web", "SKU-WEB");
    sqlite
      .prepare(
        `INSERT INTO shop_orders
           (id, order_number, email, status, financial_status,
            fulfillment_status, channel, subtotal_satang, total_satang,
            created_at, updated_at, paid_at)
         VALUES ('web-1', 'KHP-2026-00107', 'real@customer.example',
                 'paid', 'paid', 'unfulfilled', 'web', 96300, 96300,
                 '2026-08-12', '2026-08-12', '2026-08-12')`,
      )
      .run();
    return "KHP-2026-00107";
  }

  const byNumber = (
    orderNumber: string,
    to: string,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      source: "tonbab",
      orders: [{ orderNumber, action: "transition", to, ...extra }],
    }) as TonbabSyncBody;

  it("refusing refund/cancel by order number alone — a guessed number cannot refund a web order", async () => {
    const orderNumber = await seedNativeWebOrder();

    const refund = await processTonbabSync(
      d1,
      orderSvc(),
      byNumber(orderNumber, "refunded", {
        refund: { amountSatang: 96300, seq: 1 },
      }),
    );
    expect(refund[0].ok).toBe(false);
    expect(refund[0].error).toMatch(/requires externalId/);

    const cancel = await processTonbabSync(
      d1,
      orderSvc(),
      byNumber(orderNumber, "cancelled"),
    );
    expect(cancel[0].ok).toBe(false);
    expect(cancel[0].error).toMatch(/requires externalId/);

    // The web order is untouched — no ledger row, still paid.
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM shop_order_adjustments WHERE order_id = 'web-1'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        sqlite
          .prepare(
            `SELECT financial_status AS s FROM shop_orders WHERE id = 'web-1'`,
          )
          .get() as { s: string }
      ).s,
    ).toBe("paid");
  });

  it("refuses even non-destructive transitions on a non-tonbab channel", async () => {
    const orderNumber = await seedNativeWebOrder();
    const res = await processTonbabSync(
      d1,
      orderSvc(),
      byNumber(orderNumber, "fulfilled"),
    );
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toMatch(/not a tonbab_pos order/);
    expect(
      (
        sqlite
          .prepare(
            `SELECT fulfillment_status AS s FROM shop_orders WHERE id = 'web-1'`,
          )
          .get() as { s: string }
      ).s,
    ).toBe("unfulfilled");
  });

  it("records the join key in sync_log so the weaker path is auditable", async () => {
    seedVariant("var-1", "SKU-A");
    const created = await processTonbabSync(d1, orderSvc(), upsertBody("TB-J"));
    const orderId = created[0].orderId!;
    const orderNumber = (
      sqlite
        .prepare(`SELECT order_number AS n FROM shop_orders WHERE id = ?`)
        .get(orderId) as { n: string }
    ).n;

    // Identity join.
    const viaExternal = await processTonbabSync(d1, orderSvc(), {
      source: "tonbab",
      orders: [{ externalId: "TB-J", action: "transition", to: "fulfilled" }],
    } as TonbabSyncBody);
    expect(viaExternal[0].joinKey).toBe("external");

    // Order-number join, on a tonbab_pos order (allowed, non-destructive).
    const viaNumber = await processTonbabSync(
      d1,
      orderSvc(),
      byNumber(orderNumber, "delivered"),
    );
    expect(viaNumber[0]).toMatchObject({ ok: true, joinKey: "orderNumber" });

    const details = syncLogRows()
      .filter((r) => String(r.action).startsWith("transition:"))
      .map((r) => String(r.detail));
    expect(details.some((d) => d.includes("[join:external]"))).toBe(true);
    expect(details.some((d) => d.includes("[join:orderNumber]"))).toBe(true);
  });
});

describe("audit MAJOR 7 — refund seq validation and ordering", () => {
  async function seedPos(): Promise<string> {
    seedVariant("var-1", "SKU-A");
    const r = await processTonbabSync(d1, orderSvc(), upsertBody("TB-1"));
    return r[0].orderId!;
  }

  const refundBody = (refund: Record<string, unknown>) =>
    ({
      source: "tonbab",
      orders: [
        { externalId: "TB-1", action: "transition", to: "refunded", refund },
      ],
    }) as TonbabSyncBody;

  it("rejects seq values that are not a real sequence (0, negative)", async () => {
    const orderId = await seedPos();
    for (const seq of [0, -5, 1.5]) {
      const res = await processTonbabSync(
        d1,
        orderSvc(),
        refundBody({ amountSatang: 1000, seq }),
      );
      expect(res[0].ok).toBe(false);
      expect(res[0].error).toMatch(/refund\.seq must be an integer >= 1/);
    }
    // Nothing was written for any of them.
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM shop_order_adjustments WHERE order_id = ?`,
          )
          .get(orderId) as { n: number }
      ).n,
    ).toBe(0);
    // seq 1 is accepted.
    const ok = await processTonbabSync(
      d1,
      orderSvc(),
      refundBody({ amountSatang: 1000, seq: 1 }),
    );
    expect(ok[0].ok).toBe(true);
  });

  it("a replay of a recorded FULL refund reports replayed, not skipped", async () => {
    await seedPos();
    const first = await processTonbabSync(
      d1,
      orderSvc(),
      refundBody({ amountSatang: 96300, seq: 1 }),
    );
    expect(first[0]).toMatchObject({ ok: true, replayed: false });

    // Balance is now 0. Pre-fix the balance check ran BEFORE the
    // idempotency lookup, so this redelivery of an ALREADY-RECORDED
    // refund reported {skipped: true, reason: "already fully
    // refunded"} — indistinguishable from a rejection.
    const replay = await processTonbabSync(
      d1,
      orderSvc(),
      refundBody({ amountSatang: 96300, seq: 1 }),
    );
    expect(replay[0]).toMatchObject({ ok: true, replayed: true });
    expect(replay[0].skipped).toBeUndefined();

    expect(
      syncLogRows().filter((r) => r.result === "replayed").length,
    ).toBeGreaterThan(0);
  });
});

describe("audit MINOR 8 — base64 secret validation", () => {
  it("isStrictBase64 rejects plain-ASCII secrets that atob() silently mis-decodes", () => {
    // The motivating input: valid base64 ALPHABET, so atob never
    // throws — the old raw-string catch fallback was unreachable.
    expect(isStrictBase64("mysecret123")).toBe(false); // length 11, %4 != 0
    expect(isStrictBase64("my secret")).toBe(false); // space
    expect(isStrictBase64("")).toBe(false);
    expect(
      isStrictBase64(Buffer.from("tonbab-pairing-secret").toString("base64")),
    ).toBe(true);
    expect(isStrictBase64("YWJjZA==")).toBe(true);
  });

  it("a non-base64 secret still verifies via raw bytes AND logs a diagnostic", async () => {
    const raw = "mysecret123"; // NOT base64 — 11 chars
    const body = JSON.stringify({ source: "tonbab", orders: [] });
    const sig = createHmac("sha256", Buffer.from(raw, "utf8"))
      .update(body)
      .digest("base64");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await verifyTonbabSignature(raw, body, sig);
      expect(res.ok).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("not valid base64"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("audit MINOR 9 — batch size caps", () => {
  const bigBatch = (n: number) => ({
    source: "tonbab",
    orders: Array.from({ length: n }, (_, i) => ({
      externalId: `TB-${i}`,
      action: "upsert",
      items: [{ sku: "SKU-A", quantity: 1, priceSatang: 100 }],
      totals: { subtotalSatang: 100, totalSatang: 100 },
    })),
  });

  it("parse rejects an oversized batch WHOLE, before any write", () => {
    const parsed = parseTonbabSyncBody(
      JSON.stringify(bigBatch(MAX_ORDERS_PER_BATCH + 1)),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.code).toBe("BATCH_TOO_LARGE");
    expect(parseTonbabSyncBody(JSON.stringify(bigBatch(2))).ok).toBe(true);
  });

  it("parse rejects a single order with too many items", () => {
    const parsed = parseTonbabSyncBody(
      JSON.stringify({
        source: "tonbab",
        orders: [
          {
            externalId: "TB-WIDE",
            action: "upsert",
            items: Array.from({ length: MAX_ITEMS_PER_ORDER + 1 }, (_, i) => ({
              sku: `S-${i}`,
              quantity: 1,
              priceSatang: 1,
            })),
            totals: { subtotalSatang: 1, totalSatang: 1 },
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.code).toBe("BATCH_TOO_LARGE");
    expect(parsed.ok === false && parsed.message).toMatch(/orders\[0\]/);
  });

  it("the endpoint answers 413 BATCH_TOO_LARGE and stores nothing", async () => {
    const body = JSON.stringify(bigBatch(MAX_ORDERS_PER_BATCH + 1));
    const res = await postSync(body, sign(body));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "BATCH_TOO_LARGE",
    });
    expect(
      (
        sqlite.prepare(`SELECT COUNT(*) AS n FROM shop_orders`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
});
