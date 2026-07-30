/**
 * BeamCheckout adapter — implements the PaymentProvider interface for
 * Thailand-first payment methods: PromptPay QR, credit/debit card,
 * LINE Pay, TrueMoney.
 *
 * Beam is Thailand's answer to Stripe/Adyen — API surface is roughly
 * Stripe-shaped (Charge object, webhooks with HMAC signatures) but
 * with Thai payment method affinity built in. Reference implementation
 * lives at codustry/bactrack-website; this adapter lifts the client
 * shape but restructures for the plugin runtime.
 *
 * Configuration is via env vars (validated at construction time):
 *   BEAM_API_KEY — secret key from beamcheckout.com dashboard
 *   BEAM_WEBHOOK_SECRET — for HMAC signature verification
 *   BEAM_BASE_URL — defaults to https://api.beamcheckout.com/v1
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

const DEFAULT_BEAM_BASE_URL = "https://api.beamcheckout.com/v1";

export type BeamConfig = {
  apiKey: string;
  webhookSecret: string;
  baseUrl?: string;
};

/**
 * Compute HMAC-SHA256 hex signature — used both to sign outbound
 * requests (Beam auth) and to verify inbound webhook signatures.
 * Uses Web Crypto (available in Cloudflare Workers).
 */
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    if (!config.apiKey) {
      throw new Error("BeamPaymentProvider: apiKey is required");
    }
    if (!config.webhookSecret) {
      throw new Error("BeamPaymentProvider: webhookSecret is required");
    }
    this.baseUrl = config.baseUrl ?? DEFAULT_BEAM_BASE_URL;
  }

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    try {
      const res = await fetch(`${this.baseUrl}/charges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
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
      const res = await fetch(`${this.baseUrl}/refunds`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
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
    // Strip optional `sha256=` scheme prefix (Stripe convention that
    // Beam MAY adopt) so we compare hex-to-hex regardless of format.
    const providedHex = signature.toLowerCase().replace(/^sha256=/, "");
    const expected = await hmacSha256Hex(this.config.webhookSecret, rawBody);
    if (!timingSafeEqual(expected, providedHex)) {
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
