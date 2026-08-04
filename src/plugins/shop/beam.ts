/**
 * BeamCheckout adapter — implements the PaymentProvider interface for
 * Thailand-first payment methods: PromptPay QR, credit/debit card,
 * LINE Pay, TrueMoney.
 *
 * Beam serves Thai payment methods, but its API is NOT Stripe-shaped —
 * an earlier version of this adapter assumed it was and got four things
 * wrong (bearer auth, base path, and the webhook digest encoding). Per
 * https://docs.beamcheckout.com/get-started/authentication it uses
 * HTTP Basic auth:
 *
 *     Authorization: Basic base64(merchantId + ":" + apiKey)
 *
 * The merchant ID is a SEPARATE credential from the API key — it is the
 * Basic username, not something embedded in the key. Without it every
 * request is rejected, so it is required, not optional.
 *
 * ── Why Payment Links, not Charges (#151) ───────────────────────────
 *
 * The Stripe-shaped guessing didn't stop at auth. A direct
 * `POST /api/v1/charges` requires ONE pre-chosen `paymentMethod` in the
 * body — Beam 400s with "paymentMethod is a required field" otherwise.
 * Our checkout deliberately does NOT ask the customer to pick a method
 * up front; it promises method CHOICE on the payment page. The Beam
 * primitive that matches that promise is a hosted Payment Link:
 *
 *     POST /api/v1/payment-links → { paymentLinkId, url }
 *
 * The customer is redirected to `url`, picks card / PromptPay QR /
 * e-wallet there, and Beam calls our webhook when a charge (created by
 * Beam, id unknown to us at link-creation time) settles. Shapes below
 * were validated against two production Beam integrations by the #151
 * reporter — treat them as ground truth, not the old guesses:
 *
 *   - `netAmount` / `currency` / `referenceId` nest under `order`
 *     (top-level 400s), everything is camelCase, and there is NO
 *     `customer_email` or `metadata` field to send.
 *   - The field is `redirectUrl`, not `returnUrl`.
 *   - `referenceId` is set to the ORDER NUMBER. Beam echoes it in every
 *     webhook, and because the charge id doesn't exist until the
 *     customer pays, it is the ONLY join key the first payment webhook
 *     can carry that we know in advance. The webhook route matches on
 *     it when the charge-id lookup misses (see webhook/beam/+server.ts).
 *   - An `Idempotency-Key` header (our order id) makes client retries
 *     safe: same key + same body replays the original response; same
 *     key + DIFFERENT body 412s, which we surface as a non-retryable
 *     failure rather than looping.
 *
 * Configuration (validated at construction time):
 *   BEAM_MERCHANT_ID — merchant identifier; the Basic-auth username
 *   BEAM_API_KEY — secret key from the Lighthouse dashboard
 *   BEAM_WEBHOOK_SECRET — base64 HMAC key for webhook verification
 *   BEAM_BASE_URL — defaults to https://api.beamcheckout.com
 *
 * Not shipped:
 *   - Recurring payments / subscriptions (Beam doesn't support natively)
 *   - Instalment plans (v3.5+, requires Beam Plus tier)
 */
import type {
  ChargeInput,
  ChargeResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from "./payment";

// Host only — the version lives in the documented path
// (/api/v1/payment-links), not in the base URL.
// Sandbox: https://playground.api.beamcheckout.com
const DEFAULT_BEAM_BASE_URL = "https://api.beamcheckout.com";

/** Payment links expire; give the customer an hour to finish paying. */
const PAYMENT_LINK_TTL_MS = 60 * 60 * 1000;

export type BeamConfig = {
  /** Basic-auth username. Required — Beam rejects requests without it. */
  merchantId: string;
  apiKey: string;
  webhookSecret: string;
  baseUrl?: string;
};

/**
 * Compute the webhook HMAC-SHA256 digest, BASE64-encoded.
 *
 * Two details Beam specifies that a Stripe-shaped implementation gets
 * wrong (and this adapter previously did):
 *
 *  - The digest is **base64**, not hex. `X-Beam-Signature` carries base64.
 *  - The configured HMAC key is itself **base64-encoded** and must be
 *    DECODED to bytes before use. Using the base64 string as raw key
 *    material produces a digest that never matches.
 *
 * Falls back to raw-string key material when the secret is not valid
 * base64, so a misconfigured key fails signature comparison (rejecting
 * the webhook) rather than throwing inside the handler.
 */
async function hmacSha256Base64(
  base64Secret: string,
  body: string,
): Promise<string> {
  const enc = new TextEncoder();
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
  } catch {
    decoded = enc.encode(base64Secret);
  }
  // Copy into a freshly-allocated ArrayBuffer. Both branches above are
  // `Uint8Array<ArrayBufferLike>`, and importKey's BufferSource requires
  // the narrower `ArrayBuffer` backing (a SharedArrayBuffer would not be
  // valid key material).
  const keyBytes = new Uint8Array(decoded.length);
  keyBytes.set(decoded);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(body));
  const digest = new Uint8Array(sig);
  return btoa(Array.from(digest, (b) => String.fromCharCode(b)).join(""));
}

/**
 * Constant-time string comparison for signature verification.
 * Standard timing-attack mitigation for webhook secrets.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type BeamPaymentLinkResponse = {
  paymentLinkId: string;
  url: string;
};

type BeamRefundResponse = {
  id: string;
  charge_id: string;
  amount: number;
  status: "pending" | "succeeded" | "failed";
};

/**
 * Real Beam webhook bodies are FLAT (#151) — not the
 * `{event_type, data:{...}}` envelope the old parser invented. The
 * event name travels in the `X-Beam-Event` REQUEST HEADER, not the
 * body; the route reads it and passes it into verifyWebhook.
 *
 * The old envelope parser 400'd every genuine webhook AFTER the HMAC
 * passed — Beam retried ~10 times, gave up, and every paid order
 * stayed pending forever.
 */
type BeamWebhookBody = {
  chargeId?: string;
  referenceId?: string;
  status?: string;
  amount?: number;
  currency?: string;
};

export class BeamPaymentProvider implements PaymentProvider {
  readonly name = "beam";
  private readonly baseUrl: string;

  constructor(private readonly config: BeamConfig) {
    if (!config.merchantId) {
      throw new Error(
        "BeamPaymentProvider: merchantId is required — it is the HTTP Basic username",
      );
    }
    if (!config.apiKey) {
      throw new Error("BeamPaymentProvider: apiKey is required");
    }
    if (!config.webhookSecret) {
      throw new Error("BeamPaymentProvider: webhookSecret is required");
    }
    this.baseUrl = config.baseUrl ?? DEFAULT_BEAM_BASE_URL;
  }

  /**
   * HTTP Basic auth: base64(merchantId:apiKey).
   *
   * Beam does NOT use bearer tokens. Computed per call rather than cached
   * so a credential rotated through /admin/settings/secrets takes effect
   * on the next request.
   */
  private authHeader(): string {
    const raw = `${this.config.merchantId}:${this.config.apiKey}`;
    // btoa is byte-oriented; encode UTF-8 first so a non-ASCII id or key
    // does not silently produce a wrong header.
    const bytes = new TextEncoder().encode(raw);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return `Basic ${btoa(binary)}`;
  }

  /**
   * Create a hosted Payment Link (NOT a direct charge — see the header
   * comment for why: charges demand one pre-chosen paymentMethod, our
   * checkout promises method choice).
   *
   * The returned `providerChargeId` is the paymentLinkId. The REAL
   * charge id only exists after the customer pays; the webhook route
   * swaps it in via markPaid so refunds get a real charge id.
   */
  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    // The webhook's only pre-payment join key. Prefer the human order
    // number (what the reporter validated Beam echoes back); fall back
    // to the internal order id so an old call site still round-trips.
    const referenceId =
      input.orderNumber ?? input.metadata?.orderNumber ?? input.orderId;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/payment-links`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader(),
          // Same key + same body: Beam replays the original response.
          // Same key + different body: 412, handled below.
          "idempotency-key": input.orderId,
        },
        // Validated shape (#151): camelCase, money fields nested under
        // `order`, `redirectUrl` not `returnUrl`, and NO customer_email
        // or metadata — Beam has no such fields on payment links.
        body: JSON.stringify({
          collectDeliveryAddress: false,
          expiresAt: new Date(Date.now() + PAYMENT_LINK_TTL_MS).toISOString(),
          redirectUrl: input.returnUrl,
          linkSettings: {
            card: { isEnabled: true },
            cardInstallments: { isEnabled: false },
            qrPromptPay: { isEnabled: true },
            eWallets: { isEnabled: true },
            mobileBanking: { isEnabled: false },
            buyNowPayLater: { isEnabled: false },
          },
          order: {
            netAmount: input.amount, // integer satang — never decimals
            currency: input.currency,
            referenceId,
            description: input.description,
          },
        }),
      });

      if (res.status === 412) {
        // Idempotency-Key reuse with a DIFFERENT body. This is the
        // desired outcome on a client retry after e.g. an amount edit —
        // retrying the same request can never succeed, so fail loudly
        // instead of looping.
        return {
          ok: false,
          code: "IDEMPOTENCY_CONFLICT",
          message:
            "Beam rejected the payment-link request: the Idempotency-Key was already used with a different body (HTTP 412). Do not retry — start a fresh checkout for this order.",
        };
      }

      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          code: `HTTP_${res.status}`,
          message:
            text.slice(0, 500) ||
            `Beam payment-link creation failed (${res.status})`,
        };
      }

      const body = (await res.json()) as BeamPaymentLinkResponse;
      return {
        ok: true,
        providerChargeId: body.paymentLinkId,
        paymentUrl: body.url,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "NETWORK_ERROR", message };
    }
  }

  /**
   * ⚠️ REFUND SHAPE UNVALIDATED AGAINST REAL BEAM — #151 point 4.
   *
   * The charge-creation and webhook shapes below/above were validated
   * against two production Beam integrations; this refund body was NOT.
   * It is almost certainly the same guessed disease (snake_case
   * `charge_id`, top-level fields), but the #151 reporter had no real
   * refund traffic to validate against, and guessing a "more plausible"
   * camelCase shape would just be a second guess.
   *
   * DO NOT issue a production refund through this method until the real
   * shape has been captured and this block replaced. Failures already
   * surface loudly (ok:false with Beam's response text) — a wrong shape
   * fails visibly at the admin refund screen, it does not lose money.
   * A structural test (beam.node.test.ts) pins this warning so it
   * cannot silently vanish before the shape is validated.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/refunds`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader(),
        },
        body: JSON.stringify({
          charge_id: input.providerChargeId,
          amount: input.amount,
          currency: input.currency,
          reason: input.reason,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          code: `HTTP_${res.status}`,
          message: text.slice(0, 500) || `Beam refund failed (${res.status})`,
        };
      }
      const body = (await res.json()) as BeamRefundResponse;
      if (body.status === "failed") {
        return {
          ok: false,
          code: "REFUND_FAILED",
          message: `Refund ${body.id} rejected by Beam`,
        };
      }
      return { ok: true, providerRefundId: body.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "NETWORK_ERROR", message };
    }
  }

  /**
   * Verify a webhook and normalize it. HMAC mechanics are unchanged
   * from #135 (base64 digest over the raw body, base64-decoded key) —
   * only the PAYLOAD parsing changed for #151: real bodies are flat
   * ({chargeId, referenceId, status, amount, currency}), and the event
   * name arrives via the `X-Beam-Event` request header, which the
   * route reads and passes as `eventName`.
   *
   * A signed, well-formed-but-novel payload NEVER fails verification:
   * unknown or absent statuses normalize to "pending" so the route can
   * log-and-200 instead of 400ing and triggering a Beam retry storm.
   */
  async verifyWebhook(
    rawBody: string,
    signature: string,
    eventName?: string,
  ): Promise<WebhookVerifyResult> {
    if (!signature) {
      return {
        ok: false,
        code: "MISSING_SIGNATURE",
        message: "X-Beam-Signature header absent",
      };
    }
    // Beam sends a bare base64 digest. Strip a `sha256=` prefix defensively
    // (some gateways add one) but do NOT lowercase — base64 is
    // case-sensitive, and lowercasing it guarantees a mismatch.
    const provided = signature.replace(/^sha256=/, "").trim();
    const expected = await hmacSha256Base64(this.config.webhookSecret, rawBody);
    if (!timingSafeEqual(expected, provided)) {
      return { ok: false, code: "INVALID_SIGNATURE", message: "HMAC mismatch" };
    }
    let parsed: BeamWebhookBody;
    try {
      parsed = JSON.parse(rawBody) as BeamWebhookBody;
    } catch {
      return { ok: false, code: "INVALID_JSON", message: "Body is not JSON" };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        ok: false,
        code: "MALFORMED_PAYLOAD",
        message: "Body is not a JSON object",
      };
    }
    // Normalize Beam status → interface's canonical status. Compared
    // case-insensitively, and anything unrecognized maps to "pending" —
    // a novel-but-signed payload must not bounce (see docblock).
    const beamStatus =
      typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
    const status: "succeeded" | "failed" | "refunded" | "pending" =
      beamStatus === "succeeded"
        ? "succeeded"
        : beamStatus === "failed"
          ? "failed"
          : beamStatus === "refunded"
            ? "refunded"
            : "pending";
    return {
      ok: true,
      eventType: eventName ?? "",
      // `providerChargeId` keeps its name for compatibility with the
      // interface and existing callers, populated from the flat
      // body's chargeId. It may be EMPTY on link-lifecycle events that
      // predate a charge — the route falls back to referenceId then.
      providerChargeId: parsed.chargeId ?? "",
      referenceId: parsed.referenceId,
      status,
      amount: parsed.amount,
      raw: parsed,
    };
  }
}
