/**
 * v4.6.0 Beam correctness — found on bactrack.in.th (#217–#219):
 *
 *   - retries need their own idempotency key (`attempt`): every body
 *     carries a fresh expiry, and Beam 412s a reused key + new body;
 *   - `payment_link.paid` (the card / hosted-page path) has its own
 *     shape and used to normalize to "pending" — never confirmed;
 *   - getChargeStatus lets a pending order settle without the webhook;
 *   - checkSettlement refuses a payment that doesn't match the order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeamPaymentProvider, beamIdempotencyKey } from "./beam";
import { checkSettlement } from "./beam-settle.server";

vi.mock("$lib/server/analytics/track", () => ({}));
vi.mock("$lib/server/webhooks", () => ({}));

const CONFIG = {
  merchantId: "codustry-ova1t0",
  apiKey: "sk_test_abc123",
  webhookSecret: btoa("webhook-key-bytes"),
};

const CHARGE = {
  orderId: "ord_1",
  orderNumber: "KP-2026-000123",
  description: "test charge",
  amount: 10000,
  currency: "THB",
  customerEmail: "buyer@example.com",
  returnUrl: "https://example.com/return",
};

afterEach(() => vi.restoreAllMocks());

type Reply = { status: number; body?: unknown };

/** Routes GET/POST by path prefix; records every call. */
function stubBeam(routes: Record<string, Reply>) {
  const spy = vi.fn(async (url: string) => {
    const path = url.replace(/^https:\/\/[^/]+/, "");
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.startsWith(k));
    const reply = key ? routes[key] : { status: 404 };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body ?? ""),
    };
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const headersOf = (spy: ReturnType<typeof stubBeam>, i = 0) =>
  (spy.mock.calls[i] as unknown as [string, RequestInit])[1].headers as Record<
    string,
    string
  >;

describe("idempotency keys (#219)", () => {
  it("first link / QR keep their historical keys", () => {
    expect(beamIdempotencyKey({ orderId: "o" }, "link")).toBe("o");
    expect(beamIdempotencyKey({ orderId: "o" }, "qr")).toBe("o:qr");
  });

  it("a retry gets its own key per kind, never colliding with a first try", () => {
    const link = beamIdempotencyKey({ orderId: "o", attempt: "qr" }, "link");
    const qr = beamIdempotencyKey({ orderId: "o", attempt: "a1" }, "qr");
    expect(link).toBe("o:link:qr");
    expect(qr).toBe("o:qr:a1");
    expect(link).not.toBe(beamIdempotencyKey({ orderId: "o" }, "qr"));
  });

  it("createCharge and createQrCharge send the attempt-scoped key", async () => {
    const spy = stubBeam({
      "/api/v1/payment-links": { status: 200, body: { id: "pl", url: "u" } },
      "/api/v1/charges": {
        status: 200,
        body: {
          chargeId: "ch",
          encodedImage: { imageBase64Encoded: "iVBORw0KGgo=" },
        },
      },
    });
    const p = new BeamPaymentProvider(CONFIG);
    await p.createCharge({ ...CHARGE, attempt: "r2" });
    await p.createQrCharge({ ...CHARGE, attempt: "r3" });
    expect(headersOf(spy, 0)["idempotency-key"]).toBe("ord_1:link:r2");
    expect(headersOf(spy, 0)["x-beam-idempotency-key"]).toBe("ord_1:link:r2");
    expect(headersOf(spy, 1)["idempotency-key"]).toBe("ord_1:qr:r3");
  });
});

describe("payment_link.paid webhook (card / hosted page)", () => {
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
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  /** Shape per docs.beamcheckout.com/webhook-event-types. */
  const PAID = JSON.stringify({
    paymentLinkId: "plink_1",
    status: "PAID",
    order: {
      netAmount: 10000,
      currency: "THB",
      referenceId: "KP-2026-000123",
    },
    expiresAt: "2026-10-25T08:00:00Z",
  });

  it("normalizes PAID to succeeded with the nested reference and amount", async () => {
    const p = new BeamPaymentProvider(CONFIG);
    const v = await p.verifyWebhook(
      PAID,
      await sign(PAID),
      "payment_link.paid",
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.status).toBe("succeeded");
    expect(v.referenceId).toBe("KP-2026-000123");
    expect(v.amount).toBe(10000);
    // No charge id on this event: the route matches by referenceId.
    expect(v.providerChargeId).toBe("");
  });

  it("charge.failed still normalizes to failed", async () => {
    const body = JSON.stringify({
      chargeId: "ch_1",
      referenceId: "KP-2026-000123",
      status: "FAILED",
      failureCode: "card_declined",
    });
    const p = new BeamPaymentProvider(CONFIG);
    const v = await p.verifyWebhook(body, await sign(body), "charge.failed");
    expect(v.ok && v.status).toBe("failed");
  });
});

describe("getChargeStatus (#218)", () => {
  const p = () => new BeamPaymentProvider(CONFIG);

  it("reads a charge: SUCCEEDED with amount and reference", async () => {
    const spy = stubBeam({
      "/api/v1/charges/ch_1": {
        status: 200,
        body: {
          status: "SUCCEEDED",
          amount: 10000,
          referenceId: "KP-2026-000123",
        },
      },
    });
    expect(await p().getChargeStatus("ch_1")).toEqual({
      ok: true,
      status: "succeeded",
      amount: 10000,
      referenceId: "KP-2026-000123",
    });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.beamcheckout.com/api/v1/charges/ch_1");
    expect((init.headers as Record<string, string>).authorization).toMatch(
      /^Basic /,
    );
  });

  it("maps FAILED to failed and anything else to pending", async () => {
    stubBeam({
      "/api/v1/charges/": { status: 200, body: { status: "FAILED" } },
    });
    expect(await p().getChargeStatus("ch")).toMatchObject({ status: "failed" });
    stubBeam({
      "/api/v1/charges/": { status: 200, body: { status: "PENDING" } },
    });
    expect(await p().getChargeStatus("ch")).toMatchObject({
      status: "pending",
    });
  });

  it("falls back to the payment link on 404 and finds the charge behind a PAID link", async () => {
    stubBeam({
      "/api/v1/payment-links/plink_1": {
        status: 200,
        body: {
          status: "PAID",
          order: { netAmount: 10000, referenceId: "KP-2026-000123" },
        },
      },
      "/api/v1/charges?sourceId=plink_1": {
        status: 200,
        body: {
          data: [
            { chargeId: "ch_fail", status: "FAILED" },
            {
              chargeId: "ch_ok",
              status: "SUCCEEDED",
              amount: 10000,
              referenceId: "KP-2026-000123",
            },
          ],
        },
      },
    });
    expect(await p().getChargeStatus("plink_1")).toEqual({
      ok: true,
      status: "succeeded",
      amount: 10000,
      referenceId: "KP-2026-000123",
      chargeId: "ch_ok",
    });
  });

  it("an EXPIRED / DISABLED / VOIDED link is failed; ACTIVE is pending", async () => {
    for (const status of ["EXPIRED", "DISABLED", "VOIDED"]) {
      stubBeam({ "/api/v1/payment-links/": { status: 200, body: { status } } });
      expect(await p().getChargeStatus("pl")).toMatchObject({
        status: "failed",
      });
    }
    stubBeam({
      "/api/v1/payment-links/": { status: 200, body: { status: "ACTIVE" } },
    });
    expect(await p().getChargeStatus("pl")).toMatchObject({
      status: "pending",
    });
  });

  it("never reports failed for an error — ok:false instead, and never throws", async () => {
    stubBeam({ "/api/v1/charges/": { status: 500 } });
    expect(await p().getChargeStatus("ch")).toMatchObject({
      ok: false,
      code: "HTTP_500",
    });
    stubBeam({});
    expect(await p().getChargeStatus("unknown")).toMatchObject({ ok: false });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await p().getChargeStatus("ch")).toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
    });
    expect(await p().getChargeStatus("")).toMatchObject({
      ok: false,
      code: "NO_CHARGE_ID",
    });
  });
});

describe("checkSettlement", () => {
  const order = { totalSatang: 10000, orderNumber: "KP-2026-000123" };

  it("settles when what was reported matches, or wasn't reported", () => {
    expect(checkSettlement(order, {})).toEqual({ ok: true });
    expect(
      checkSettlement(order, { amount: 10000, referenceId: "KP-2026-000123" }),
    ).toEqual({ ok: true });
  });

  it("refuses a different amount or a different order's reference", () => {
    expect(checkSettlement(order, { amount: 100 }).ok).toBe(false);
    expect(checkSettlement(order, { referenceId: "KP-2026-000124" }).ok).toBe(
      false,
    );
  });
});
