import { describe, it, expect, vi, afterEach } from "vitest";
import { BeamPaymentProvider } from "./beam";

/**
 * Contract tests against BeamCheckout's documented API.
 *
 * These exist because the adapter was originally written on the
 * assumption that Beam is "roughly Stripe-shaped". It is not, and four
 * things were wrong as a result — bearer auth instead of HTTP Basic, a
 * missing merchant ID, `/v1` in the base URL instead of `/api/v1` in the
 * path, and a hex webhook digest instead of base64.
 *
 * None of it was caught by a test, because nothing asserted the wire
 * format. These tests pin the format itself, per
 * https://docs.beamcheckout.com/get-started/authentication
 */

const CONFIG = {
  merchantId: "codustry-ova1t0",
  apiKey: "sk_test_abc123",
  webhookSecret: btoa("webhook-key-bytes"), // Beam stores this base64
};

/** Matches ChargeInput in payment.ts — kept in one place so a shape change breaks once. */
const CHARGE = {
  orderId: "ord_1",
  description: "test charge",
  amount: 10000,
  currency: "THB",
  customerEmail: "buyer@example.com",
  returnUrl: "https://example.com/return",
};

afterEach(() => vi.restoreAllMocks());

function mockFetch(body: unknown, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("Beam authentication", () => {
  it("uses HTTP Basic with base64(merchantId:apiKey), NOT bearer", async () => {
    const fetchSpy = mockFetch({ id: "chg_1", status: "pending" });
    const provider = new BeamPaymentProvider(CONFIG);
    await provider.createCharge(CHARGE);

    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    const expected = `Basic ${btoa("codustry-ova1t0:sk_test_abc123")}`;
    expect(headers.authorization).toBe(expected);
    expect(headers.authorization).not.toMatch(/^Bearer/);
  });

  it("posts to /api/v1/charges on the bare host", async () => {
    // The version belongs in the path, not the base URL. With `/v1` in
    // the base the request went to /v1/charges and 404'd.
    const fetchSpy = mockFetch({ id: "chg_1", status: "pending" });
    await new BeamPaymentProvider(CONFIG).createCharge(CHARGE);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://api.beamcheckout.com/api/v1/charges",
    );
  });

  it("honours a sandbox base URL override", async () => {
    const fetchSpy = mockFetch({ id: "chg_1", status: "pending" });
    await new BeamPaymentProvider({
      ...CONFIG,
      baseUrl: "https://playground.api.beamcheckout.com",
    }).createCharge(CHARGE);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://playground.api.beamcheckout.com/api/v1/charges",
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
