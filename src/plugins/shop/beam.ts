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

// Host only — the version lives in the documented path (/api/v1/charges),
// not in the base URL. Sandbox: https://playground.api.beamcheckout.com
const DEFAULT_BEAM_BASE_URL = "https://api.beamcheckout.com";

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

type BeamChargeCreateResponse = {
  id: string;
  status: "pending" | "succeeded" | "failed";
  amount: number;
  currency: string;
  payment_url?: string;
  qr_code_url?: string; // PromptPay QR
  metadata?: Record<string, string>;
};

type BeamRefundResponse = {
  id: string;
  charge_id: string;
  amount: number;
  status: "pending" | "succeeded" | "failed";
};

type BeamWebhookEnvelope = {
  event_type: string;
  data: {
    id: string;
    status: "pending" | "succeeded" | "failed" | "refunded";
    amount?: number;
  };
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

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/charges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader(),
        },
        body: JSON.stringify({
          amount: input.amount,
          currency: input.currency,
          description: input.description,
          customer_email: input.customerEmail,
          return_url: input.returnUrl,
          metadata: {
            order_id: input.orderId,
            ...(input.metadata ?? {}),
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          code: `HTTP_${res.status}`,
          message:
            text.slice(0, 500) || `Beam charge creation failed (${res.status})`,
        };
      }

      const body = (await res.json()) as BeamChargeCreateResponse;
      return {
        ok: true,
        providerChargeId: body.id,
        paymentUrl: body.payment_url,
        extra: body.qr_code_url ? { qrCodeUrl: body.qr_code_url } : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "NETWORK_ERROR", message };
    }
  }

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

  async verifyWebhook(
    rawBody: string,
    signature: string,
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
    let parsed: BeamWebhookEnvelope;
    try {
      parsed = JSON.parse(rawBody) as BeamWebhookEnvelope;
    } catch {
      return { ok: false, code: "INVALID_JSON", message: "Body is not JSON" };
    }
    const beamStatus = parsed.data?.status;
    if (!beamStatus) {
      return {
        ok: false,
        code: "MALFORMED_PAYLOAD",
        message: "data.status missing",
      };
    }
    // Normalize Beam status → interface's canonical status.
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
      eventType: parsed.event_type,
      providerChargeId: parsed.data.id,
      status,
      amount: parsed.data.amount,
      raw: parsed,
    };
  }
}
