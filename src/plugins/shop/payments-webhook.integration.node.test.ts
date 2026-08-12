import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as beamWebhookPOST } from "../../routes/api/shop/webhook/beam/+server";
import { POST as stripeWebhookPOST } from "../../routes/api/shop/webhook/stripe/+server";
import { actions as adminOrderActions } from "../../routes/(admin)/admin/shop/orders/[id]/+page.server";
import { resolveProviderForMethod } from "./beam-config.server";
import { registerPaymentProvider } from "./payment";
import type { PaymentProvider } from "./payment";

/**
 * End-to-end payments-domain tests against REAL SQLite with the REAL
 * migrations (same harness as checkout-start.integration.node.test.ts):
 *
 *  - Beam refund.* webhook events → adjustments ledger, keyed on the
 *    provider refundId (https://docs.beamcheckout.com/webhook-event-types)
 *  - Stripe checkout.session.completed → markPaid with the
 *    payment_intent id swap
 *  - Per-method provider routing matrix (#160 E-3)
 *  - The admin refund action consuming provider capabilities
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

const NOW = "2026-08-12T10:00:00.000Z";
const BEAM_WEBHOOK_SECRET = btoa("webhook-key-bytes");
const STRIPE_WEBHOOK_SECRET = "whsec_testsecret";

let sqlite: Database.Database;
let d1: D1Database;

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

/** Env with BOTH providers configured from env vars (no DB secrets). */
function paymentsEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: d1,
    BEAM_MERCHANT_ID: "merchant-1",
    BEAM_API_KEY: "sk_beam_test",
    BEAM_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: "sk_test_abc",
    STRIPE_WEBHOOK_SECRET,
    ...overrides,
  };
}

/** ContentProvider stub — webhook fan-out and settings only. */
const contentStub = {
  listWebhooksByEvent: async () => [],
  getSettings: async () => null,
} as unknown as import("$lib/server/content/types").ContentProvider;

function seedOrder(
  id: string,
  opts: {
    orderNumber?: string;
    status?: string;
    financialStatus?: string;
    providerName?: string;
    providerChargeId?: string | null;
    totalSatang?: number;
  } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO shop_orders
         (id, order_number, email, status, financial_status, provider_name,
          provider_charge_id, subtotal_satang, total_satang, created_at, updated_at)
       VALUES (?, ?, 'buyer@example.com', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.orderNumber ?? `KP-2026-${id}`,
      opts.status ?? "paid",
      opts.financialStatus ?? "paid",
      opts.providerName ?? "beam",
      opts.providerChargeId === undefined ? "ch_real_1" : opts.providerChargeId,
      opts.totalSatang ?? 25000,
      opts.totalSatang ?? 25000,
      NOW,
      NOW,
    );
}

function adjustmentRows(orderId: string) {
  return sqlite
    .prepare(
      `SELECT id, kind, amount_satang, idempotency_key, provider_refund_id
         FROM shop_order_adjustments WHERE order_id = ?`,
    )
    .all(orderId) as Array<{
    kind: string;
    amount_satang: number;
    idempotency_key: string | null;
    provider_refund_id: string | null;
  }>;
}

function orderRow(orderId: string) {
  return sqlite
    .prepare(
      `SELECT status, financial_status, provider_charge_id, provider_name
         FROM shop_orders WHERE id = ?`,
    )
    .get(orderId) as {
    status: string;
    financial_status: string;
    provider_charge_id: string | null;
    provider_name: string | null;
  };
}

// ─── Signers ────────────────────────────────────────────────

/** Beam's documented scheme: base64 HMAC with the base64-DECODED key. */
async function beamSign(body: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(BEAM_WEBHOOK_SECRET), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return btoa(
    Array.from(new Uint8Array(sig), (b) => String.fromCharCode(b)).join(""),
  );
}

/** Stripe's v1 scheme: hex HMAC over `${t}.${body}`. */
async function stripeSignHeader(body: string, t?: number): Promise<string> {
  const ts = t ?? Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${ts}.${body}`),
  );
  const hex = Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `t=${ts},v1=${hex}`;
}

async function postBeamWebhook(body: string, eventName?: string) {
  const url = new URL("http://localhost/api/shop/webhook/beam");
  const request = new Request(url, {
    method: "POST",
    body,
    headers: {
      "x-beam-signature": await beamSign(body),
      // Absent header simulates a proxy dropping X-Beam-Event.
      ...(eventName === undefined ? {} : { "x-beam-event": eventName }),
    },
  });
  return beamWebhookPOST({
    request,
    url,
    platform: { env: paymentsEnv() },
    locals: { content: contentStub },
  } as unknown as Parameters<typeof beamWebhookPOST>[0]);
}

async function postStripeWebhook(body: string, signature?: string) {
  const url = new URL("http://localhost/api/shop/webhook/stripe");
  const request = new Request(url, {
    method: "POST",
    body,
    headers: {
      "stripe-signature": signature ?? (await stripeSignHeader(body)),
    },
  });
  return stripeWebhookPOST({
    request,
    url,
    platform: { env: paymentsEnv() },
    locals: { content: contentStub },
  } as unknown as Parameters<typeof stripeWebhookPOST>[0]);
}

// ─── Beam refund events ─────────────────────────────────────

describe("Beam refund.* webhook events", () => {
  const refundEvent = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      refundId: "rf_1",
      chargeId: "ch_real_1",
      referenceId: "KP-2026-ord-1",
      amount: 25000,
      currency: "THB",
      status: "SUCCEEDED",
      refundReason: "Customer requested refund",
      ...over,
    });

  it("records a full refund keyed beam:refund:<refundId>", async () => {
    seedOrder("ord-1");
    const res = await postBeamWebhook(refundEvent(), "refund.succeeded");
    expect(res.status).toBe(200);

    const rows = adjustmentRows("ord-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_satang).toBe(-25000);
    expect(rows[0].kind).toBe("refund_full");
    expect(rows[0].idempotency_key).toBe("beam:refund:rf_1");
    expect(rows[0].provider_refund_id).toBe("rf_1");
    expect(orderRow("ord-1").financial_status).toBe("refunded");
  });

  it("is idempotent under Beam's at-least-once retries", async () => {
    seedOrder("ord-1");
    await postBeamWebhook(refundEvent(), "refund.succeeded");
    const replay = await postBeamWebhook(refundEvent(), "refund.succeeded");
    expect(replay.status).toBe(200);
    expect(adjustmentRows("ord-1")).toHaveLength(1);
  });

  it("records a PARTIAL refund from the event amount (card charges)", async () => {
    seedOrder("ord-1");
    await postBeamWebhook(refundEvent({ amount: 10000 }), "refund.succeeded");
    const rows = adjustmentRows("ord-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_satang).toBe(-10000);
    expect(rows[0].kind).toBe("refund_partial");
    expect(orderRow("ord-1").financial_status).toBe("partially_refunded");
  });

  it("does NOT record refund.failed — the ledger holds settled money only", async () => {
    seedOrder("ord-1");
    const res = await postBeamWebhook(
      refundEvent({ status: "FAILED", failureCode: "x" }),
      "refund.failed",
    );
    expect(res.status).toBe(200);
    expect(adjustmentRows("ord-1")).toHaveLength(0);
    expect(orderRow("ord-1").financial_status).toBe("paid");
  });

  it("never misreads refund.succeeded as a payment", async () => {
    // The refund payload's status is SUCCEEDED — without the event-name
    // branch it would fall into the charge switch and call markPaid.
    seedOrder("ord-1", { status: "paid", financialStatus: "paid" });
    await postBeamWebhook(refundEvent(), "refund.succeeded");
    // provider_charge_id must NOT have been overwritten by a markPaid.
    expect(orderRow("ord-1").financial_status).toBe("refunded");
    expect(orderRow("ord-1").status).not.toBe("paid");
  });

  it("routes a refund body to the refund path even WITHOUT the X-Beam-Event header", async () => {
    // Audit F4: keyed solely off the header, a proxy-stripped
    // refund.succeeded (body status SUCCEEDED) would fall into the
    // charge switch → markPaid (CAS no-op) and the refund would be
    // silently lost. The refundId in the body is a refund payload's
    // fingerprint — belt and braces.
    seedOrder("ord-1");
    const res = await postBeamWebhook(refundEvent(), undefined);
    expect(res.status).toBe(200);
    const rows = adjustmentRows("ord-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe("beam:refund:rf_1");
    expect(orderRow("ord-1").financial_status).toBe("refunded");
  });

  it("dedupes the echo of an admin-initiated refund by providerRefundId", async () => {
    seedOrder("ord-1");
    // Admin already recorded this refund under its form-nonce key,
    // persisting the provider refund id Beam now echoes back.
    sqlite
      .prepare(
        `INSERT INTO shop_order_adjustments
           (id, order_id, kind, amount_satang, idempotency_key,
            provider_refund_id, created_at)
         VALUES ('adm-1', 'ord-1', 'refund_partial', -10000, 'nonce-1', 'rf_1', ?)`,
      )
      .run(NOW);
    const res = await postBeamWebhook(
      refundEvent({ amount: 10000 }),
      "refund.succeeded",
    );
    expect(res.status).toBe(200);
    // Still exactly one row — the webhook echo recorded nothing new.
    expect(adjustmentRows("ord-1")).toHaveLength(1);
  });
});

// ─── Stripe webhook ─────────────────────────────────────────

describe("Stripe checkout.session.completed webhook", () => {
  const completed = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          payment_intent: "pi_123",
          client_reference_id: "KP-2026-ord-s1",
          amount_total: 25000,
          payment_status: "paid",
          ...over,
        },
      },
    });

  it("marks the order paid and swaps in the payment_intent id", async () => {
    seedOrder("ord-s1", {
      status: "pending",
      financialStatus: "pending",
      providerName: "stripe",
      providerChargeId: "cs_test_1", // what checkout stored
    });
    const res = await postStripeWebhook(completed());
    expect(res.status).toBe(200);
    const row = orderRow("ord-s1");
    expect(row.financial_status).toBe("paid");
    // Refunds need pi_..., not cs_... — same id swap Beam does.
    expect(row.provider_charge_id).toBe("pi_123");
  });

  it("joins via client_reference_id when the stored session id differs", async () => {
    // Mirrors Beam's referenceId fallback: the order number is the
    // pre-payment join key.
    seedOrder("ord-s1", {
      status: "pending",
      financialStatus: "pending",
      providerName: "stripe",
      providerChargeId: null,
    });
    const res = await postStripeWebhook(completed());
    expect(res.status).toBe(200);
    expect(orderRow("ord-s1").financial_status).toBe("paid");
  });

  it("rejects a stale signature (replay window)", async () => {
    seedOrder("ord-s1", { status: "pending", financialStatus: "pending" });
    const body = completed();
    const res = await postStripeWebhook(
      body,
      await stripeSignHeader(body, Math.floor(Date.now() / 1000) - 600),
    );
    expect(res.status).toBe(400);
    expect(orderRow("ord-s1").financial_status).toBe("pending");
  });

  it("acknowledges checkout.session.expired without cancelling", async () => {
    seedOrder("ord-s1", { status: "pending", financialStatus: "pending" });
    const body = JSON.stringify({
      type: "checkout.session.expired",
      data: {
        object: { id: "cs_test_1", client_reference_id: "KP-2026-ord-s1" },
      },
    });
    const res = await postStripeWebhook(body);
    expect(res.status).toBe(200);
    // Order untouched — the customer can mint a fresh session.
    expect(orderRow("ord-s1").status).toBe("pending");
  });

  it("503s (so Stripe retries) when the order is not findable yet", async () => {
    const res = await postStripeWebhook(completed());
    expect(res.status).toBe(503);
  });
});

// ─── Crossed-provider settlement (audit F1) ─────────────────

describe("the settling provider re-stamps providerName", () => {
  it("Stripe settling an order re-stamped 'beam' flips it back to stripe", async () => {
    // Sequence: card → Stripe session minted; customer retries with
    // promptpay → pay route re-stamps beam; then completes the STILL
    // OPEN Stripe session. providerName must follow the money, or the
    // admin refund dispatches this Stripe payment_intent to Beam.
    seedOrder("ord-s1", {
      status: "pending",
      financialStatus: "pending",
      providerName: "beam", // the promptpay retry's re-stamp
      providerChargeId: "ch_beam_qr_1", // Beam QR charge id
    });
    const res = await postStripeWebhook(
      JSON.stringify({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_1",
            payment_intent: "pi_123",
            client_reference_id: "KP-2026-ord-s1",
            payment_status: "paid",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const row = orderRow("ord-s1");
    expect(row.financial_status).toBe("paid");
    expect(row.provider_charge_id).toBe("pi_123");
    expect(row.provider_name).toBe("stripe");
  });

  it("Beam settling an order stamped 'stripe' flips it back to beam", async () => {
    // Mirror image: Stripe session minted (providerName=stripe), but
    // the customer pays the Beam QR that was created first.
    seedOrder("ord-x1", {
      status: "pending",
      financialStatus: "pending",
      providerName: "stripe",
      providerChargeId: "cs_test_9",
    });
    const res = await postBeamWebhook(
      JSON.stringify({
        chargeId: "ch_real_9",
        referenceId: "KP-2026-ord-x1",
        status: "SUCCEEDED",
        amount: 25000,
        currency: "THB",
      }),
      "charge.succeeded",
    );
    expect(res.status).toBe(200);
    const row = orderRow("ord-x1");
    expect(row.financial_status).toBe("paid");
    expect(row.provider_charge_id).toBe("ch_real_9");
    expect(row.provider_name).toBe("beam");
  });
});

// ─── Stripe charge.refunded (audit F2) ──────────────────────

describe("Stripe charge.refunded webhook", () => {
  const chargeRefunded = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_123",
          amount_refunded: 10000,
          refunds: { data: [{ id: "re_1", amount: 10000 }] },
          ...over,
        },
      },
    });

  function seedStripePaidOrder() {
    seedOrder("ord-s1", {
      providerName: "stripe",
      providerChargeId: "pi_123", // markPaid already swapped it in
    });
  }

  it("records a dashboard refund keyed stripe:refund:<re_id>", async () => {
    seedStripePaidOrder();
    const res = await postStripeWebhook(chargeRefunded());
    expect(res.status).toBe(200);
    const rows = adjustmentRows("ord-s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_satang).toBe(-10000);
    expect(rows[0].kind).toBe("refund_partial");
    expect(rows[0].idempotency_key).toBe("stripe:refund:re_1");
    expect(rows[0].provider_refund_id).toBe("re_1");
    expect(orderRow("ord-s1").financial_status).toBe("partially_refunded");
  });

  it("is idempotent under Stripe's at-least-once retries", async () => {
    seedStripePaidOrder();
    await postStripeWebhook(chargeRefunded());
    const replay = await postStripeWebhook(chargeRefunded());
    expect(replay.status).toBe(200);
    expect(adjustmentRows("ord-s1")).toHaveLength(1);
  });

  it("dedupes the echo of an admin-initiated refund by provider_refund_id", async () => {
    seedStripePaidOrder();
    sqlite
      .prepare(
        `INSERT INTO shop_order_adjustments
           (id, order_id, kind, amount_satang, idempotency_key,
            provider_refund_id, created_at)
         VALUES ('adm-1', 'ord-s1', 'refund_partial', -10000, 'nonce-1', 're_1', ?)`,
      )
      .run(NOW);
    const res = await postStripeWebhook(chargeRefunded());
    expect(res.status).toBe(200);
    expect(adjustmentRows("ord-s1")).toHaveLength(1);
  });

  it("falls back to the cumulative amount_refunded delta when the refunds list is absent", async () => {
    // Newer Stripe API versions omit `refunds` from the charge object.
    seedStripePaidOrder();
    const res = await postStripeWebhook(
      chargeRefunded({ amount_refunded: 5000, refunds: undefined }),
    );
    expect(res.status).toBe(200);
    const rows = adjustmentRows("ord-s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_satang).toBe(-5000);
    // No re_ id available — keyed by the charge id instead.
    expect(rows[0].idempotency_key).toBe("stripe:refund:pi_123");
  });

  it("records a FULL refund and flips the financial axis", async () => {
    seedStripePaidOrder();
    await postStripeWebhook(
      chargeRefunded({
        amount_refunded: 25000,
        refunds: { data: [{ id: "re_full", amount: 25000 }] },
      }),
    );
    const rows = adjustmentRows("ord-s1");
    expect(rows[0].kind).toBe("refund_full");
    expect(orderRow("ord-s1").financial_status).toBe("refunded");
  });

  it("acknowledges (200) a refund for an unknown order — retrying can never match", async () => {
    const res = await postStripeWebhook(chargeRefunded());
    expect(res.status).toBe(200);
  });
});

// ─── Routing matrix ─────────────────────────────────────────

describe("resolveProviderForMethod routing matrix (#160 E-3)", () => {
  it("routes 'card' to Stripe when its keys are configured", async () => {
    const p = await resolveProviderForMethod(paymentsEnv(), "card");
    expect(p?.name).toBe("stripe");
  });

  it("falls back to Beam for 'card' when Stripe is unconfigured", async () => {
    // Preserves pre-Stripe behaviour: the Beam hosted link serves card.
    const p = await resolveProviderForMethod(
      paymentsEnv({
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: undefined,
      }),
      "card",
    );
    expect(p?.name).toBe("beam");
  });

  it("routes 'promptpay' to Beam even with Stripe configured", async () => {
    const p = await resolveProviderForMethod(paymentsEnv(), "promptpay");
    expect(p?.name).toBe("beam");
  });

  it("defaults to Beam when no method is given", async () => {
    const p = await resolveProviderForMethod(paymentsEnv(), undefined);
    expect(p?.name).toBe("beam");
  });

  it("returns null when nothing is configured", async () => {
    // No provider env vars and no BETTER_AUTH_SECRET → no DB secrets
    // either. Checkout surfaces its purposeful 503.
    const p = await resolveProviderForMethod({ DB: d1 }, "card");
    expect(p).toBeNull();
  });
});

// ─── Admin refund action × capabilities ─────────────────────

describe("admin refund action consumes provider capabilities", () => {
  function fakeProvider(partialRefunds: boolean): PaymentProvider {
    return {
      name: "fakepay",
      capabilities: { partialRefunds },
      createCharge: async () => ({ ok: true, providerChargeId: "x" }),
      refund: async () => ({ ok: true, providerRefundId: "rf_fake" }),
      verifyWebhook: () => ({
        ok: false,
        code: "NOPE",
        message: "not used here",
      }),
    };
  }

  async function runRefund(amountBaht: string, kind: string) {
    const fd = new FormData();
    fd.set("amount", amountBaht);
    fd.set("kind", kind);
    fd.set("idempotencyKey", "test-nonce-1");
    const url = new URL("http://localhost/admin/shop/orders/ord-1");
    return adminOrderActions.refund({
      request: new Request(url, { method: "POST", body: fd }),
      url,
      params: { id: "ord-1" },
      platform: { env: paymentsEnv() },
      locals: {
        user: { id: "admin-1", email: "admin@example.com", role: "admin" },
        content: contentStub,
      },
    } as unknown as Parameters<typeof adminOrderActions.refund>[0]);
  }

  it("refuses a partial refund when capabilities.partialRefunds is false", async () => {
    registerPaymentProvider(fakeProvider(false));
    seedOrder("ord-1", { providerName: "fakepay" });
    const result = (await runRefund("100", "refund_partial")) as {
      status?: number;
      data?: { error?: string };
    };
    expect(result.status).toBe(400);
    expect(result.data?.error).toMatch(/does not support partial refunds/);
    expect(adjustmentRows("ord-1")).toHaveLength(0);
  });

  it("still allows a FULL refund on the same provider", async () => {
    registerPaymentProvider(fakeProvider(false));
    seedOrder("ord-1", { providerName: "fakepay" });
    const result = (await runRefund("", "refund_full")) as {
      success?: boolean;
    };
    expect(result.success).toBe(true);
    const rows = adjustmentRows("ord-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_satang).toBe(-25000);
  });

  it("allows partial refunds when the provider declares support", async () => {
    registerPaymentProvider(fakeProvider(true));
    seedOrder("ord-1", { providerName: "fakepay" });
    const result = (await runRefund("100", "refund_partial")) as {
      success?: boolean;
    };
    expect(result.success).toBe(true);
    expect(adjustmentRows("ord-1")[0].amount_satang).toBe(-10000);
  });
});
