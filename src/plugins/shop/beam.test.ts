import { describe, it, expect, vi, afterEach } from "vitest";
import { BeamPaymentProvider } from "./beam";

/**
 * Contract tests against BeamCheckout's REAL API.
 *
 * These exist because the adapter was originally written on the
 * assumption that Beam is "roughly Stripe-shaped". It is not, and it
 * bit twice: first auth/path/digest (#135 — bearer auth instead of
 * HTTP Basic, a missing merchant ID, `/v1` in the base URL instead of
 * `/api/v1` in the path, a hex webhook digest instead of base64), then
 * the request/webhook BODIES themselves (#151 — a guessed charges call
 * that real Beam 400s, and an invented webhook envelope that rejected
 * every genuine event after the HMAC passed).
 *
 * None of it was caught by a test, because nothing asserted the wire
 * format. These tests pin the format itself: auth per
 * https://docs.beamcheckout.com/get-started/authentication, and the
 * payment-link + flat-webhook shapes as validated against two
 * production Beam integrations by the #151 reporter.
 */

const CONFIG = {
  merchantId: "codustry-ova1t0",
  apiKey: "sk_test_abc123",
  webhookSecret: btoa("webhook-key-bytes"), // Beam stores this base64
};

/** Matches ChargeInput in payment.ts — kept in one place so a shape change breaks once. */
const CHARGE = {
  orderId: "ord_1",
  orderNumber: "KP-2026-000123",
  description: "test charge",
  amount: 10000,
  currency: "THB",
  customerEmail: "buyer@example.com",
  returnUrl: "https://example.com/return",
};

/** What a successful POST /api/v1/payment-links returns. */
const LINK_RESPONSE = { paymentLinkId: "plink_1", url: "https://pay.example" };

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

describe("Beam authentication", () => {
  it("uses HTTP Basic with base64(merchantId:apiKey), NOT bearer", async () => {
    const fetchSpy = mockFetch(LINK_RESPONSE);
    const provider = new BeamPaymentProvider(CONFIG);
    await provider.createCharge(CHARGE);

    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    const expected = `Basic ${btoa("codustry-ova1t0:sk_test_abc123")}`;
    expect(headers.authorization).toBe(expected);
    expect(headers.authorization).not.toMatch(/^Bearer/);
  });

  it("posts to /api/v1/payment-links on the bare host", async () => {
    // The version belongs in the path, not the base URL. And it is
    // payment-links, NOT charges — direct charges require ONE
    // pre-chosen paymentMethod (Beam 400s without it), while our
    // checkout promises method choice on the hosted page (#151).
    const fetchSpy = mockFetch(LINK_RESPONSE);
    await new BeamPaymentProvider(CONFIG).createCharge(CHARGE);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://api.beamcheckout.com/api/v1/payment-links",
    );
  });

  it("honours a sandbox base URL override", async () => {
    const fetchSpy = mockFetch(LINK_RESPONSE);
    await new BeamPaymentProvider({
      ...CONFIG,
      baseUrl: "https://playground.api.beamcheckout.com",
    }).createCharge(CHARGE);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://playground.api.beamcheckout.com/api/v1/payment-links",
    );
  });

  it("refuses to construct without a merchant ID", () => {
    // Failing loudly at construction beats 401-ing on every charge with
    // an error the customer sees at checkout.
    expect(
      () => new BeamPaymentProvider({ ...CONFIG, merchantId: "" }),
    ).toThrow(/merchantId is required/);
  });

  it("refuses to construct without an api key or webhook secret", () => {
    expect(() => new BeamPaymentProvider({ ...CONFIG, apiKey: "" })).toThrow(
      /apiKey is required/,
    );
    expect(
      () => new BeamPaymentProvider({ ...CONFIG, webhookSecret: "" }),
    ).toThrow(/webhookSecret is required/);
  });

  it("encodes non-ASCII credentials as UTF-8 before base64", () => {
    // btoa is byte-oriented and throws on code points > 255. Encoding
    // first means an unusual merchant id degrades to a wrong header
    // rather than an exception inside checkout.
    expect(
      () => new BeamPaymentProvider({ ...CONFIG, merchantId: "ร้าน-ทดสอบ" }),
    ).not.toThrow();
  });
});

describe("Beam payment-link creation (#151)", () => {
  const provider = new BeamPaymentProvider(CONFIG);

  function sentBody(spy: ReturnType<typeof mockFetch>) {
    return JSON.parse(spy.mock.calls[0][1].body as string) as Record<
      string,
      unknown
    >;
  }

  it("nests netAmount/currency/referenceId/description under `order`", async () => {
    // Top-level money fields 400 on real Beam — the nesting is the
    // validated shape, not a style choice.
    const spy = mockFetch(LINK_RESPONSE);
    await provider.createCharge(CHARGE);
    const body = sentBody(spy);
    expect(body.order).toEqual({
      netAmount: 10000, // integer satang, never decimal baht
      currency: "THB",
      referenceId: "KP-2026-000123",
      description: "test charge",
    });
    expect(body).not.toHaveProperty("netAmount");
    expect(body).not.toHaveProperty("currency");
  });

  it("sets referenceId to the ORDER NUMBER — the webhook join key", async () => {
    // Beam echoes referenceId in every webhook. Before a charge exists
    // it is the ONLY key the payment webhook shares with checkout.
    const spy = mockFetch(LINK_RESPONSE);
    await provider.createCharge(CHARGE);
    const order = sentBody(spy).order as Record<string, unknown>;
    expect(order.referenceId).toBe(CHARGE.orderNumber);
  });

  it("falls back to metadata.orderNumber, then orderId, for referenceId", async () => {
    const spy = mockFetch(LINK_RESPONSE);
    const { orderNumber: _omit, ...noNumber } = CHARGE;
    await provider.createCharge({
      ...noNumber,
      metadata: { orderNumber: "KP-META-1" },
    });
    expect((sentBody(spy).order as Record<string, unknown>).referenceId).toBe(
      "KP-META-1",
    );

    const spy2 = mockFetch(LINK_RESPONSE);
    await provider.createCharge(noNumber);
    expect((sentBody(spy2).order as Record<string, unknown>).referenceId).toBe(
      "ord_1",
    );
  });

  it("uses `redirectUrl` (not returnUrl) and sends an ISO expiresAt", async () => {
    const spy = mockFetch(LINK_RESPONSE);
    const before = Date.now();
    await provider.createCharge(CHARGE);
    const body = sentBody(spy);
    expect(body.redirectUrl).toBe("https://example.com/return");
    expect(body).not.toHaveProperty("returnUrl");
    expect(body).not.toHaveProperty("return_url");
    // expiresAt: ISO timestamp roughly now + 60 minutes.
    const expires = Date.parse(body.expiresAt as string);
    expect(Number.isNaN(expires)).toBe(false);
    expect(expires - before).toBeGreaterThan(55 * 60 * 1000);
    expect(expires - before).toBeLessThan(65 * 60 * 1000);
  });

  it("sends NO customer_email and NO metadata — Beam has no such fields", async () => {
    const spy = mockFetch(LINK_RESPONSE);
    await provider.createCharge({ ...CHARGE, metadata: { foo: "bar" } });
    const raw = spy.mock.calls[0][1].body as string;
    expect(raw).not.toContain("customer_email");
    expect(raw).not.toContain("customerEmail");
    expect(raw).not.toContain("metadata");
  });

  it("declares the method mix via linkSettings", async () => {
    const spy = mockFetch(LINK_RESPONSE);
    await provider.createCharge(CHARGE);
    expect(sentBody(spy).linkSettings).toEqual({
      card: { isEnabled: true },
      cardInstallments: { isEnabled: false },
      qrPromptPay: { isEnabled: true },
      eWallets: { isEnabled: true },
      mobileBanking: { isEnabled: false },
      buyNowPayLater: { isEnabled: false },
    });
  });

  it("sends an Idempotency-Key header so client retries are safe", async () => {
    const spy = mockFetch(LINK_RESPONSE);
    await provider.createCharge(CHARGE);
    const headers = spy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("ord_1");
  });

  it("treats a 412 (key reuse, different body) as non-retryable", async () => {
    // Beam 412s when an Idempotency-Key is replayed with a DIFFERENT
    // body — retrying the same request can never succeed.
    mockFetch({ error: "precondition failed" }, false, 412);
    const res = await provider.createCharge(CHARGE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(res.message).toMatch(/[Dd]o not retry/);
    }
  });

  it("maps paymentLinkId → providerChargeId and url → paymentUrl", async () => {
    mockFetch(LINK_RESPONSE);
    const res = await provider.createCharge(CHARGE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.providerChargeId).toBe("plink_1");
      expect(res.paymentUrl).toBe("https://pay.example");
    }
  });
});

describe("Beam webhook verification", () => {
  const provider = new BeamPaymentProvider(CONFIG);

  /** Reference implementation of Beam's documented scheme. */
  async function sign(body: string, base64Key: string): Promise<string> {
    const keyBytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
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

  const body = JSON.stringify({ data: { status: "succeeded", id: "chg_1" } });

  it("accepts a correctly base64-signed payload", async () => {
    const result = await provider.verifyWebhook(
      body,
      await sign(body, CONFIG.webhookSecret),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a hex digest", async () => {
    // The previous implementation produced hex. Beam sends base64, so
    // every real webhook would have been rejected — orders paid but
    // never confirmed.
    const keyBytes = Uint8Array.from(atob(CONFIG.webhookSecret), (c) =>
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
    const hex = Array.from(new Uint8Array(sig), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    const result = await provider.verifyWebhook(body, hex);
    expect(result.ok).toBe(false);
  });

  it("decodes the base64 HMAC key before signing", async () => {
    // Using the base64 STRING as key material (rather than its decoded
    // bytes) yields a digest that never matches.
    const wrong = await (async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(CONFIG.webhookSecret),
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
    })();

    expect((await provider.verifyWebhook(body, wrong)).ok).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = await sign(body, CONFIG.webhookSecret);
    const tampered = JSON.stringify({
      data: { status: "succeeded", id: "chg_ATTACKER" },
    });
    expect((await provider.verifyWebhook(tampered, sig)).ok).toBe(false);
  });

  it("rejects a missing signature", async () => {
    const result = await provider.verifyWebhook(body, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_SIGNATURE");
  });

  it("does not lowercase the signature", async () => {
    // base64 is case-sensitive; lowercasing guarantees a mismatch. The
    // old implementation did exactly that.
    const sig = await sign(body, CONFIG.webhookSecret);
    expect(sig).not.toBe(sig.toLowerCase()); // fixture has mixed case
    expect((await provider.verifyWebhook(body, sig)).ok).toBe(true);
  });

  it("tolerates a sha256= prefix", async () => {
    const sig = await sign(body, CONFIG.webhookSecret);
    expect((await provider.verifyWebhook(body, `sha256=${sig}`)).ok).toBe(true);
  });
});

describe("Beam webhook payload parsing (#151)", () => {
  const provider = new BeamPaymentProvider(CONFIG);

  /** Same reference signer as above — real payloads still get real HMACs. */
  async function sign(body: string): Promise<string> {
    const keyBytes = Uint8Array.from(atob(CONFIG.webhookSecret), (c) =>
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

  /** A REAL Beam body: flat, no {event_type, data} envelope. */
  const FLAT = JSON.stringify({
    chargeId: "ch_real_1",
    referenceId: "KP-2026-000123",
    status: "succeeded",
    amount: 10000,
    currency: "THB",
  });

  it("parses the FLAT body — not the invented {event_type, data} envelope", async () => {
    // The old parser demanded data.status and 400'd every genuine
    // webhook AFTER the HMAC passed. Beam retried ~10x, gave up, and
    // every paid order stayed pending forever.
    const result = await provider.verifyWebhook(FLAT, await sign(FLAT));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("succeeded");
      expect(result.amount).toBe(10000);
    }
  });

  it("populates providerChargeId from the flat chargeId", async () => {
    const result = await provider.verifyWebhook(FLAT, await sign(FLAT));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerChargeId).toBe("ch_real_1");
  });

  it("carries referenceId through — the pre-charge order join key", async () => {
    const result = await provider.verifyWebhook(FLAT, await sign(FLAT));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.referenceId).toBe("KP-2026-000123");
  });

  it("takes the event name from the eventName parameter (X-Beam-Event header)", async () => {
    // The event name is NOT in the body — the route reads the
    // X-Beam-Event request header and passes it in.
    const result = await provider.verifyWebhook(
      FLAT,
      await sign(FLAT),
      "charge.succeeded",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eventType).toBe("charge.succeeded");
  });

  it("normalizes failed and refunded statuses", async () => {
    for (const s of ["failed", "refunded"] as const) {
      const body = JSON.stringify({ chargeId: "ch_1", status: s });
      const result = await provider.verifyWebhook(body, await sign(body));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe(s);
    }
  });

  it("maps unknown or absent statuses to 'pending' — never rejects a signed novel payload", async () => {
    // Rejecting a signed-but-unfamiliar event makes Beam retry-storm.
    // Unknown statuses degrade to pending; the route logs and 200s.
    for (const body of [
      JSON.stringify({ chargeId: "ch_1", status: "authorized_v2" }),
      JSON.stringify({ chargeId: "ch_1" }),
      JSON.stringify({ referenceId: "KP-1", status: 42 }),
    ]) {
      const result = await provider.verifyWebhook(body, await sign(body));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe("pending");
    }
  });

  it("compares statuses case-insensitively", async () => {
    const body = JSON.stringify({ chargeId: "ch_1", status: "SUCCEEDED" });
    const result = await provider.verifyWebhook(body, await sign(body));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("succeeded");
  });

  it("returns an empty providerChargeId when the event predates a charge", async () => {
    // Link-lifecycle events can fire before any charge exists. The
    // route then joins on referenceId instead.
    const body = JSON.stringify({ referenceId: "KP-2026-000123", status: "x" });
    const result = await provider.verifyWebhook(body, await sign(body));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerChargeId).toBe("");
      expect(result.referenceId).toBe("KP-2026-000123");
    }
  });
});
