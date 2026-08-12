import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderService } from "./order-service";
import { notifyNewOrder } from "./notify";
import { trackingUrl, carrierLabel } from "./carriers";
import type { OrderWithItems } from "./order-service";

/**
 * Phase C (C1/C2/C4/C10) — fulfillments, order timeline, operator
 * notification, returns v1. Same better-sqlite3 + migration-replay
 * harness as order-axes-ledger.integration.node.test.ts: every test
 * runs against the REAL migrations, 0026 included.
 */
const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations(db: Database.Database) {
  for (const file of migrationFiles()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
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

const NOW = "2026-08-12T10:00:00.000Z";

type RecordedEvent = { event: string; payload: Record<string, unknown> };

/** Seed an order directly with the three axes set (post-0026 shape). */
function seedOrder(
  db: Database.Database,
  id: string,
  opts: {
    financial?: string;
    fulfillment?: string;
    legacy?: string;
    totalSatang?: number;
  } = {},
) {
  const financial = opts.financial ?? "paid";
  const fulfillment = opts.fulfillment ?? "unfulfilled";
  db.prepare(
    `INSERT INTO shop_orders
       (id, order_number, email, status, financial_status, fulfillment_status,
        provider_name, subtotal_satang, total_satang, created_at, updated_at)
     VALUES (?, ?, 'buyer@example.com', ?, ?, ?, 'beam', 25000, ?, ?, ?)`,
  ).run(
    id,
    `KHP-2026-${id}`,
    opts.legacy ?? (financial === "pending" ? "pending" : "paid"),
    financial,
    fulfillment,
    opts.totalSatang ?? 25000,
    NOW,
    NOW,
  );
}

function events(db: Database.Database, orderId: string) {
  return db
    .prepare(
      `SELECT kind, message, actor_email FROM shop_order_events
       WHERE order_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(orderId) as Array<{
    kind: string;
    message: string | null;
    actor_email: string | null;
  }>;
}

function orderAxes(db: Database.Database, orderId: string) {
  return db
    .prepare(
      `SELECT financial_status, fulfillment_status, return_status, status
       FROM shop_orders WHERE id = ?`,
    )
    .get(orderId) as {
    financial_status: string;
    fulfillment_status: string;
    return_status: string | null;
    status: string;
  };
}

let sqlite: Database.Database;
let d1: D1Database;
let recorded: RecordedEvent[];
let svc: OrderService;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  d1 = d1Shim(sqlite);
  recorded = [];
  svc = new OrderService(d1, {
    emitEvent: (event, payload) => recorded.push({ event, payload }),
  });
});

// ─── Migration 0026 ─────────────────────────────────────────

describe("0026 — operations tables exist after full replay", () => {
  it("creates shop_fulfillments, shop_order_events, shop_returns with their columns", () => {
    const cols = (table: string) =>
      sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => (c as { name: string }).name);
    expect(cols("shop_fulfillments")).toEqual([
      "id",
      "order_id",
      "carrier",
      "tracking_number",
      "fulfilled_at",
      "notified_at",
    ]);
    expect(cols("shop_order_events")).toEqual([
      "id",
      "order_id",
      "kind",
      "message",
      "actor_email",
      "created_at",
    ]);
    expect(cols("shop_returns")).toEqual([
      "id",
      "order_id",
      "state",
      "reason_text",
      "items_json",
      "created_at",
      "resolved_at",
    ]);
    const indexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toContain("shop_fulfillments_order_id_idx");
    expect(indexes).toContain("shop_order_events_order_created_idx");
    expect(indexes).toContain("shop_returns_order_id_idx");
  });
});

// ─── C1 — fulfillment with carrier + tracking ───────────────

describe("C1 — markFulfilled records the shipment", () => {
  it("writes the fulfillment row, timeline event, and tracked payload", async () => {
    seedOrder(sqlite, "o1");
    const f = await svc.markFulfilled("o1", {
      carrier: "kerry",
      trackingNumber: "KEX123",
      actorEmail: "admin@shop.test",
    });
    expect(f).not.toBeNull();
    expect(f?.carrier).toBe("kerry");
    expect(f?.trackingNumber).toBe("KEX123");
    expect(f?.notifiedAt).toBeNull();

    const row = sqlite
      .prepare(`SELECT * FROM shop_fulfillments WHERE order_id = 'o1'`)
      .get() as Record<string, unknown>;
    expect(row.carrier).toBe("kerry");
    expect(row.tracking_number).toBe("KEX123");

    const evs = events(sqlite, "o1");
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("fulfilled");
    expect(evs[0].message).toContain("Kerry Express");
    expect(evs[0].message).toContain("KEX123");
    expect(evs[0].actor_email).toBe("admin@shop.test");

    // order.fulfilled carries the tracking data (C1 acceptance).
    const emitted = recorded.find((e) => e.event === "order.fulfilled");
    expect(emitted).toBeDefined();
    expect(emitted?.payload.carrier).toBe("kerry");
    expect(emitted?.payload.trackingNumber).toBe("KEX123");
    expect(emitted?.payload.fulfillmentStatus).toBe("fulfilled");

    expect(orderAxes(sqlite, "o1").fulfillment_status).toBe("fulfilled");
  });

  it("no-ops (null, no row, no event) when the order is not fulfillable", async () => {
    seedOrder(sqlite, "o2", {
      financial: "pending",
      fulfillment: "unfulfilled",
    });
    const f = await svc.markFulfilled("o2", { carrier: "flash" });
    expect(f).toBeNull();
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM shop_fulfillments`).get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
    expect(events(sqlite, "o2")).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("latestFulfillment reads back; markFulfillmentNotified stamps the send", async () => {
    seedOrder(sqlite, "o3");
    const f = await svc.markFulfilled("o3", {
      carrier: "thailand_post",
      trackingNumber: "EX1TH",
    });
    await svc.markFulfillmentNotified(f!.id);
    const latest = await svc.latestFulfillment("o3");
    expect(latest?.id).toBe(f!.id);
    expect(latest?.notifiedAt).not.toBeNull();
  });

  it("carriers module builds tracking links and labels", () => {
    expect(trackingUrl("kerry", "KEX 123")).toBe(
      "https://th.kerryexpress.com/th/track/?track=KEX%20123",
    );
    expect(trackingUrl("other", "X1")).toBeNull();
    expect(trackingUrl("kerry", null)).toBeNull();
    expect(carrierLabel("jt")).toBe("J&T Express");
    expect(carrierLabel("gone-carrier")).toBe("gone-carrier");
  });
});

// ─── C2 — timeline ──────────────────────────────────────────

describe("C2 — every transition lands on the timeline", () => {
  it("markPaid winner writes 'paid' once; the retry writes nothing", async () => {
    seedOrder(sqlite, "p1", { financial: "pending" });
    const first = await svc.markPaid({
      orderId: "p1",
      providerChargeId: "ch_1",
    });
    expect(first.justPaid).toBe(true);
    const retry = await svc.markPaid({
      orderId: "p1",
      providerChargeId: "ch_1",
    });
    expect(retry.justPaid).toBe(false);
    const evs = events(sqlite, "p1").filter((e) => e.kind === "paid");
    expect(evs).toHaveLength(1);
    expect(evs[0].message).toContain("beam");
    expect(recorded.filter((e) => e.event === "order.paid")).toHaveLength(1);
  });

  it("refund event carries amount + reason (B6 reason becomes readable); idempotent replays don't duplicate", async () => {
    seedOrder(sqlite, "r1");
    await svc.recordRefund({
      orderId: "r1",
      amountSatang: 10000,
      reason: "Damaged in transit",
      actorEmail: "admin@shop.test",
      kind: "refund_partial",
      idempotencyKey: "k-1",
    });
    // Replay: same key, same body → no second timeline event.
    await svc.recordRefund({
      orderId: "r1",
      amountSatang: 10000,
      reason: "Damaged in transit",
      kind: "refund_partial",
      idempotencyKey: "k-1",
    });
    const refunds = events(sqlite, "r1").filter((e) => e.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].message).toContain("100.00");
    expect(refunds[0].message).toContain("Damaged in transit");
    expect(refunds[0].actor_email).toBe("admin@shop.test");
  });

  it("delivered and cancelled transitions write events", async () => {
    seedOrder(sqlite, "d1", { fulfillment: "fulfilled", legacy: "fulfilled" });
    await svc.markDelivered("d1", { actorEmail: "admin@shop.test" });
    expect(events(sqlite, "d1").map((e) => e.kind)).toContain("delivered");

    seedOrder(sqlite, "c1", { financial: "pending" });
    await svc.markCancelled({ orderId: "c1" });
    expect(events(sqlite, "c1").map((e) => e.kind)).toContain("cancelled");
  });

  it("addOrderNote appends kind='note' with the actor; empty notes are rejected", async () => {
    seedOrder(sqlite, "n1");
    await svc.addOrderNote({
      orderId: "n1",
      message: "Customer called — resend invoice",
      actorEmail: "admin@shop.test",
    });
    const evs = events(sqlite, "n1");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toEqual({
      kind: "note",
      message: "Customer called — resend invoice",
      actor_email: "admin@shop.test",
    });
    await expect(
      svc.addOrderNote({ orderId: "n1", message: "   " }),
    ).rejects.toThrow(/empty/);
    await expect(
      svc.addOrderNote({ orderId: "missing", message: "x" }),
    ).rejects.toThrow(/not found/);
  });

  it("listOrderEvents returns newest first", async () => {
    seedOrder(sqlite, "t1");
    // Insert with distinct timestamps directly — service writes can
    // land in the same millisecond.
    for (const [i, kind] of ["created", "paid", "note"].entries()) {
      sqlite
        .prepare(
          `INSERT INTO shop_order_events (id, order_id, kind, created_at)
           VALUES (?, 't1', ?, ?)`,
        )
        .run(`ev-${i}`, kind, `2026-08-12T10:0${i}:00.000Z`);
    }
    const list = await svc.listOrderEvents("t1");
    expect(list.map((e) => e.kind)).toEqual(["note", "paid", "created"]);
  });
});

// ─── C10 — returns v1 ───────────────────────────────────────

describe("C10 — returns state machine + return_status axis", () => {
  it("requestReturn requires paid + shipped", async () => {
    seedOrder(sqlite, "x1", { financial: "pending" });
    await expect(svc.requestReturn({ orderId: "x1" })).rejects.toThrow(
      /not returnable/,
    );
    seedOrder(sqlite, "x2", { financial: "paid", fulfillment: "unfulfilled" });
    await expect(svc.requestReturn({ orderId: "x2" })).rejects.toThrow(
      /not shipped/,
    );
  });

  it("walks the happy path requested → approved → received → refunded, syncing the axis", async () => {
    seedOrder(sqlite, "x3", { fulfillment: "delivered", legacy: "delivered" });
    const ret = await svc.requestReturn({
      orderId: "x3",
      reasonText: "Wrong size",
    });
    expect(ret.state).toBe("requested");
    expect(orderAxes(sqlite, "x3").return_status).toBe("requested");

    await svc.transitionReturn({ returnId: ret.id, to: "approved" });
    expect(orderAxes(sqlite, "x3").return_status).toBe("approved");

    await svc.transitionReturn({ returnId: ret.id, to: "received" });
    expect(orderAxes(sqlite, "x3").return_status).toBe("received");

    const done = await svc.transitionReturn({
      returnId: ret.id,
      to: "refunded",
      actorEmail: "admin@shop.test",
    });
    expect(done.state).toBe("refunded");
    expect(done.resolvedAt).not.toBeNull();
    expect(orderAxes(sqlite, "x3").return_status).toBe("resolved");

    const kinds = events(sqlite, "x3").map((e) => e.kind);
    expect(kinds).toEqual([
      "return_requested",
      "return_approved",
      "return_received",
      "return_refunded",
    ]);
    // The customer's reason lands on the timeline.
    expect(events(sqlite, "x3")[0].message).toContain("Wrong size");
  });

  it("rejects illegal transitions and treats refunded/rejected as terminal", async () => {
    seedOrder(sqlite, "x4", { fulfillment: "fulfilled", legacy: "fulfilled" });
    const ret = await svc.requestReturn({ orderId: "x4" });
    // requested → received skips approval.
    await expect(
      svc.transitionReturn({ returnId: ret.id, to: "received" }),
    ).rejects.toThrow(/Illegal return transition/);
    // requested → refunded skips the whole flow.
    await expect(
      svc.transitionReturn({ returnId: ret.id, to: "refunded" }),
    ).rejects.toThrow(/Illegal return transition/);
    await svc.transitionReturn({ returnId: ret.id, to: "rejected" });
    expect(orderAxes(sqlite, "x4").return_status).toBe("resolved");
    // Terminal — nothing moves out of rejected.
    for (const to of ["approved", "received", "refunded"] as const) {
      await expect(
        svc.transitionReturn({ returnId: ret.id, to }),
      ).rejects.toThrow(/Illegal return transition/);
    }
  });

  it("blocks a second return while one is in flight, allows one after rejection", async () => {
    seedOrder(sqlite, "x5", { fulfillment: "delivered", legacy: "delivered" });
    const ret = await svc.requestReturn({ orderId: "x5" });
    await expect(svc.requestReturn({ orderId: "x5" })).rejects.toThrow(
      /already in progress/,
    );
    await svc.transitionReturn({ returnId: ret.id, to: "rejected" });
    // Resolved returns don't block a fresh request.
    const second = await svc.requestReturn({ orderId: "x5" });
    expect(second.state).toBe("requested");
    expect((await svc.listReturns("x5")).length).toBe(2);
  });

  it("snapshots requested items as JSON", async () => {
    seedOrder(sqlite, "x6", { fulfillment: "fulfilled", legacy: "fulfilled" });
    const ret = await svc.requestReturn({
      orderId: "x6",
      items: [{ orderItemId: "li-1", quantity: 2 }],
    });
    expect(JSON.parse(ret.itemsJson ?? "[]")).toEqual([
      { orderItemId: "li-1", quantity: 2 },
    ]);
  });
});

// ─── C4 — operator notification ─────────────────────────────

function fakeOrder(): OrderWithItems {
  return {
    id: "ord-1",
    orderNumber: "KHP-2026-00001",
    userId: null,
    email: "buyer@example.com",
    status: "paid",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    returnStatus: null,
    channel: "online_store",
    providerName: "beam",
    providerChargeId: "ch_1",
    subtotalSatang: 25000,
    shippingSatang: 0,
    taxSatang: 0,
    taxIncludedSatang: 0,
    taxMode: "exclusive",
    discountSatang: 0,
    totalSatang: 25000,
    shippingAddressJson: null,
    billingAddressJson: null,
    discountCodeSnapshot: null,
    createdAt: NOW,
    updatedAt: NOW,
    paidAt: NOW,
    fulfilledAt: null,
    deliveredAt: null,
    refundedAt: null,
    cancelledAt: null,
    externalSource: null,
    externalId: null,
    items: [
      {
        id: "li-1",
        orderId: "ord-1",
        variantId: "v-1",
        quantity: 1,
        titleSnapshot: "JetKVM",
        skuSnapshot: "JK-1",
        priceSnapshotSatang: 25000,
        lineSubtotalSatang: 25000,
        lineTaxSatang: 0,
        discountAllocatedSatang: 0,
      },
    ],
    adjustments: [],
  };
}

describe("C4 — operator notification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends email + LINE when both channels are configured", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      }),
    );
    const result = await notifyNewOrder(
      {
        RESEND_API_KEY: "re_test",
        RESEND_FROM: "shop@example.com",
        LINE_NOTIFY_TOKEN: "line_test",
        PUBLIC_SITE_URL: "https://shop.example.com",
      },
      fakeOrder(),
      { notifyEmail: "owner@example.com" },
    );
    expect(result).toEqual({ email: true, line: true });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.resend.com/emails",
      "https://notify-api.line.me/api/notify",
    ]);
    const emailBody = JSON.parse(String(calls[0].init.body));
    expect(emailBody.to).toEqual(["owner@example.com"]);
    expect(emailBody.subject).toContain("KHP-2026-00001");
    expect(String(calls[1].init.body)).toContain("KHP-2026-00001");
  });

  it("skips channels that are not configured", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    // No notify email, no LINE token, no DB → nothing to send.
    const result = await notifyNewOrder(
      { RESEND_API_KEY: "re_test", RESEND_FROM: "shop@example.com" },
      fakeOrder(),
      {},
    );
    expect(result).toEqual({ email: false, line: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("NEVER throws — a dead network resolves to false/false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(
      notifyNewOrder(
        {
          RESEND_API_KEY: "re_test",
          RESEND_FROM: "shop@example.com",
          LINE_NOTIFY_TOKEN: "line_test",
        },
        fakeOrder(),
        { notifyEmail: "owner@example.com" },
      ),
    ).resolves.toEqual({ email: false, line: false });
  });

  it("markPaid's justPaid gates the winner-only send", async () => {
    seedOrder(sqlite, "w1", { financial: "pending" });
    const sends: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sends.push(url);
        return new Response("{}", { status: 200 });
      }),
    );
    const env = {
      RESEND_API_KEY: "re_test",
      RESEND_FROM: "shop@example.com",
    };
    // The webhook route's pattern: notify only when the CAS was won.
    for (let i = 0; i < 3; i++) {
      const paid = await svc.markPaid({ orderId: "w1", providerChargeId: "c" });
      if (paid.justPaid) {
        await notifyNewOrder(env, paid, { notifyEmail: "owner@example.com" });
      }
    }
    expect(sends).toHaveLength(1);
  });
});
