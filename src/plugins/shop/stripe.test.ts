import { describe, it, expect, vi, afterEach } from "vitest";
import { StripePaymentProvider } from "./stripe";

/**
 * Contract tests for the Stripe adapter (#160 E-3, #116). Same policy
 * as beam.test.ts: pin the WIRE format (auth, encoding, field names),
 * because that is exactly what a refactor can silently break and no
 * type check will catch.
 */

const CONFIG = {
  secretKey: "sk_test_abc123",
  webhookSecret: "whsec_testsecret",
};

const CHARGE = {
  orderId: "ord_1",
  orderNumber: "KP-2026-000123",
  description: "test charge",
  amount: 10000, // satang — must pass through untouched
  currency: "THB",
  customerEmail: "buyer@example.com",
  returnUrl: "https://example.com/return",
};

const SESSION_RESPONSE = {
  id: "cs_test_1",
  url: "https://checkout.stripe.com/c/pay/cs_test_1",
  payment_intent: null,
};

afterEach(() => vi.restoreAllMocks());

function mockFetch(body: unknown, ok = true, status?: number) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: status ?? (ok ? 200 : 400),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sentParams(spy: ReturnType<typeof mockFetch>) {
  return new URLSearchParams(spy.mock.calls[0][1].body as string);
}

describe("Stripe construction & capabilities", () => {
  it("declares partial-refund support — consumed by the admin refund action", () => {
    const provider = new StripePaymentProvider(CONFIG);
    expect(provider.capabilities).toEqual({ partialRefunds: true });
    expect(provider.name).toBe("stripe");
  });

  it("refuses to construct without a secret key or webhook secret", () => {
    expect(
      () => new StripePaymentProvider({ ...CONFIG, secretKey: "" }),
    ).toThrow(/secretKey is required/);
    expect(
      () => new StripePaymentProvider({ ...CONFIG, webhookSecret: "" }),
    ).toThrow(/webhookSecret is required/);
  });
});

describe("Stripe checkout session creation", () => {
  const provider = new StripePaymentProvider(CONFIG);

  it("posts form-encoded to /v1/checkout/sessions with Bearer auth", async () => {
    const spy = mockFetch(SESSION_RESPONSE);
    await provider.createCharge(CHARGE);
    expect(spy.mock.calls[0][0]).toBe(
      "https://api.stripe.com/v1/checkout/sessions",
    );
    const headers = spy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_abc123");
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["idempotency-key"]).toBe("ord_1");
  });

  it("pins payment_method_types to card — Thai rails stay on Beam", async () => {
    const spy = mockFetch(SESSION_RESPONSE);
    await provider.createCharge(CHARGE);
    const params = sentParams(spy);
    expect(params.get("payment_method_types[0]")).toBe("card");
    expect(params.getAll("payment_method_types[0]")).toHaveLength(1);
  });

  it("encodes line_items with bracket notation and passes satang through", async () => {
    const spy = mockFetch(SESSION_RESPONSE);
    await provider.createCharge(CHARGE);
    const params = sentParams(spy);
    expect(params.get("mode")).toBe("payment");
    expect(params.get("line_items[0][quantity]")).toBe("1");
    expect(params.get("line_items[0][price_data][currency]")).toBe("thb");
    // Smallest currency unit passthrough: 10000 satang stays 10000 —
    // never converted to 100.00 baht.
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("10000");
    expect(params.get("line_items[0][price_data][product_data][name]")).toBe(
      "test charge",
    );
  });

  it("carries both join keys: client_reference_id = order number, metadata.orderId", async () => {
    const spy = mockFetch(SESSION_RESPONSE);
    await provider.createCharge(CHARGE);
    const params = sentParams(spy);
    expect(params.get("client_reference_id")).toBe("KP-2026-000123");
    expect(params.get("metadata[orderId]")).toBe("ord_1");
    expect(params.get("customer_email")).toBe("buyer@example.com");
  });

  it("uses the returnUrl for both success_url and cancel_url", async () => {
    const spy = mockFetch(SESSION_RESPONSE);
    await provider.createCharge(CHARGE);
    const params = sentParams(spy);
    expect(params.get("success_url")).toBe("https://example.com/return");
    expect(params.get("cancel_url")).toBe("https://example.com/return");
  });

  it("maps session id → providerChargeId and url → paymentUrl", async () => {
    mockFetch(SESSION_RESPONSE);
    const res = await provider.createCharge(CHARGE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.providerChargeId).toBe("cs_test_1");
      expect(res.paymentUrl).toBe(
        "https://checkout.stripe.com/c/pay/cs_test_1",
      );
    }
  });

  it("surfaces Stripe's error.message on HTTP failures", async () => {
    mockFetch({ error: { message: "Invalid currency: xxx" } }, false, 400);
    const res = await provider.createCharge(CHARGE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("HTTP_400");
      expect(res.message).toBe("Invalid currency: xxx");
    }
  });

  it("returns ok:false on network failure — never throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(provider.createCharge(CHARGE)).resolves.toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
    });
  });
});

describe("Stripe refunds", () => {
  const provider = new StripePaymentProvider(CONFIG);

  it("refunds a payment_intent with an explicit amount", async () => {
    const spy = mockFetch({ id: "re_1", status: "succeeded" });
    const res = await provider.refund({
      providerChargeId: "pi_123",
      amount: 5000,
      currency: "THB",
      reason: "customer request",
    });
    expect(spy.mock.calls[0][0]).toBe("https://api.stripe.com/v1/refunds");
    const params = sentParams(spy);
    expect(params.get("payment_intent")).toBe("pi_123");
    expect(params.get("amount")).toBe("5000");
    expect(res).toEqual({ ok: true, providerRefundId: "re_1" });
  });

  it("uses the `charge` field for a ch_... id", async () => {
    const spy = mockFetch({ id: "re_2", status: "succeeded" });
    await provider.refund({
      providerChargeId: "ch_123",
      amount: 5000,
      currency: "THB",
    });
    const params = sentParams(spy);
    expect(params.get("charge")).toBe("ch_123");
    expect(params.get("payment_intent")).toBeNull();
  });

  it("refuses to refund a raw checkout-session id (cs_...)", async () => {
    // The session id means markPaid never swapped in the
    // payment_intent — there is nothing settled to refund.
    const spy = mockFetch({ id: "re_x" });
    const res = await provider.refund({
      providerChargeId: "cs_test_1",
      amount: 5000,
      currency: "THB",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NO_PAYMENT_INTENT");
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a failed refund status to ok:false", async () => {
    mockFetch({ id: "re_3", status: "failed" });
    const res = await provider.refund({
      providerChargeId: "pi_123",
      amount: 5000,
      currency: "THB",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("REFUND_FAILED");
  });
});

describe("Stripe webhook verification", () => {
  const provider = new StripePaymentProvider(CONFIG);

  /** Reference implementation of Stripe's v1 scheme. */
  async function signHeader(
    body: string,
    opts: { t?: number; secret?: string } = {},
  ): Promise<string> {
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(opts.secret ?? CONFIG.webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${t}.${body}`),
    );
    const hex = Array.from(new Uint8Array(sig), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return `t=${t},v1=${hex}`;
  }

  const COMPLETED = JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        payment_intent: "pi_123",
        client_reference_id: "KP-2026-000123",
        amount_total: 10000,
        payment_status: "paid",
      },
    },
  });

  it("accepts a valid t=/v1= signature and maps checkout.session.completed", async () => {
    const result = await provider.verifyWebhook(
      COMPLETED,
      await signHeader(COMPLETED),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("succeeded");
      expect(result.eventType).toBe("checkout.session.completed");
      // payment_intent preferred over the session id — refunds need it.
      expect(result.providerChargeId).toBe("pi_123");
      expect(result.referenceId).toBe("KP-2026-000123");
      expect(result.amount).toBe(10000);
    }
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const result = await provider.verifyWebhook(
      COMPLETED,
      await signHeader(COMPLETED, { secret: "whsec_WRONG" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_SIGNATURE");
  });

  it("rejects a tampered body", async () => {
    const header = await signHeader(COMPLETED);
    const tampered = COMPLETED.replace("10000", "1");
    expect((await provider.verifyWebhook(tampered, header)).ok).toBe(false);
  });

  it("rejects a stale timestamp — replay window is 5 minutes", async () => {
    // The timestamp is inside the signed payload, so an attacker
    // cannot freshen a captured request without breaking the HMAC.
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    const result = await provider.verifyWebhook(
      COMPLETED,
      await signHeader(COMPLETED, { t: stale }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_TOO_OLD");
  });

  it("accepts any matching v1 among several (secret rotation)", async () => {
    const good = await signHeader(COMPLETED);
    const [t, v1] = good.split(",");
    const rotated = `${t},v1=${"0".repeat(64)},${v1}`;
    expect((await provider.verifyWebhook(COMPLETED, rotated)).ok).toBe(true);
  });

  it("rejects a missing or malformed header", async () => {
    expect((await provider.verifyWebhook(COMPLETED, "")).ok).toBe(false);
    const malformed = await provider.verifyWebhook(COMPLETED, "v0=abc");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe("MALFORMED_SIGNATURE");
  });

  it("maps checkout.session.expired to 'pending' — never cancels the order", async () => {
    // An expired session is not a failed payment: the customer can
    // mint a fresh session from the order page. The route logs + 200s.
    const body = JSON.stringify({
      type: "checkout.session.expired",
      data: { object: { id: "cs_test_1", client_reference_id: "KP-1" } },
    });
    const result = await provider.verifyWebhook(body, await signHeader(body));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("pending");
  });

  it("treats async_payment_succeeded with payment_status paid as succeeded", async () => {
    // Delayed-notification payment methods settle via
    // checkout.session.async_payment_succeeded, not `completed` —
    // without this mapping a delayed payment would settle at Stripe
    // and the order stay pending forever.
    const body = JSON.stringify({
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: "cs_test_1",
          payment_intent: "pi_123",
          client_reference_id: "KP-2026-000123",
          payment_status: "paid",
        },
      },
    });
    const result = await provider.verifyWebhook(body, await signHeader(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("succeeded");
      expect(result.providerChargeId).toBe("pi_123");
    }
  });

  it("maps charge.refunded to 'refunded' with the re_... id and amount", async () => {
    // Dashboard/API refunds arrive as charge.refunded carrying a
    // Charge object whose refunds list (most recent first) names the
    // individual refund — the route keys ledger idempotency on it.
    const body = JSON.stringify({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_123",
          amount_refunded: 10000,
          refunds: { data: [{ id: "re_1", amount: 10000 }] },
        },
      },
    });
    const result = await provider.verifyWebhook(body, await signHeader(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("refunded");
      expect(result.providerChargeId).toBe("pi_123");
      expect(result.providerRefundId).toBe("re_1");
      expect(result.amount).toBe(10000);
    }
  });

  it("still maps charge.refunded when the refunds list is omitted (newer API versions)", async () => {
    // Newer Stripe API versions drop `refunds` from the charge object
    // by default — the route then derives the delta from the
    // cumulative amount_refunded carried in `raw`.
    const body = JSON.stringify({
      type: "charge.refunded",
      data: {
        object: { id: "ch_1", payment_intent: "pi_123", amount_refunded: 5000 },
      },
    });
    const result = await provider.verifyWebhook(body, await signHeader(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("refunded");
      expect(result.providerRefundId).toBeUndefined();
      expect(result.amount).toBeUndefined();
    }
  });

  it("maps novel event types to 'pending' — no retry storms", async () => {
    const body = JSON.stringify({
      type: "payment_intent.created",
      data: { object: { id: "pi_9" } },
    });
    const result = await provider.verifyWebhook(body, await signHeader(body));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("pending");
  });
});
