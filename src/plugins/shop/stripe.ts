/**
 * Stripe adapter — the second PaymentProvider (#160 E-3, #116),
 * covering card payments where Beam's hosted link is not wanted.
 *
 * Deliberately NO stripe-node SDK: this runs on Cloudflare Workers,
 * and the interface needs exactly three calls — Checkout Session
 * create, Refund create, webhook verify — all of which are plain
 * `fetch` + Web Crypto, matching beam.ts's style.
 *
 * ── Flow ────────────────────────────────────────────────────────────
 * createCharge → POST /v1/checkout/sessions (form-encoded, Bearer
 * auth). The response's `id` (cs_...) is stored as providerChargeId
 * and `url` is the hosted payment page. When the customer pays,
 * Stripe posts `checkout.session.completed`; verifyWebhook maps it to
 * status "succeeded" and surfaces the session's `payment_intent`
 * (pi_...) as providerChargeId — the webhook route persists that via
 * markPaid (same id-swap Beam does for payment links), because
 * REFUNDS need the payment_intent, not the session id.
 *
 * Join keys mirror Beam's: `client_reference_id` carries the ORDER
 * NUMBER (echoed back on the session object) and `metadata.orderId`
 * carries the internal id.
 *
 * Money: Stripe's `unit_amount` is in the smallest currency unit —
 * satang for THB — exactly what ChargeInput.amount already is, so the
 * value passes through untouched. Never convert to decimal baht.
 *
 * Config:
 *   STRIPE_SECRET_KEY     — sk_live_/sk_test_ from the Stripe dashboard
 *   STRIPE_WEBHOOK_SECRET — whsec_... for the webhook endpoint
 */
import type {
  ChargeInput,
  ChargeResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  WebhookVerifyResult,
} from "./payment";

const DEFAULT_STRIPE_BASE_URL = "https://api.stripe.com";

/**
 * Reject webhook timestamps older than 5 minutes. Stripe's own SDKs
 * default to 300s: the signed payload includes the timestamp, so a
 * captured request replayed later fails this check even though its
 * HMAC is still valid — the tolerance bounds the replay window while
 * absorbing ordinary clock skew and retry latency.
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  baseUrl?: string;
};

/** HMAC-SHA256 over `payload`, hex-encoded — Stripe's `v1` scheme. */
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Constant-time string comparison — same mitigation as beam.ts. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type StripeCheckoutSession = {
  id?: string;
  url?: string | null;
  payment_intent?: string | null;
  client_reference_id?: string | null;
  amount_total?: number | null;
  payment_status?: string;
};

/**
 * `charge.refunded` payloads carry a Charge object, not a session:
 * `id` is ch_..., `payment_intent` joins back to the order, and
 * `amount_refunded` is the CUMULATIVE satang refunded so far. The
 * `refunds.data[]` list (most recent first) supplies the individual
 * re_... id and amount — present on classic API versions; newer ones
 * omit the list by default, so both are optional and the webhook
 * route falls back to a cumulative-delta calculation.
 */
type StripeChargeObject = {
  id?: string;
  payment_intent?: string | null;
  amount_refunded?: number;
  refunds?: { data?: Array<{ id?: string; amount?: number }> };
};

type StripeEventEnvelope = {
  type?: string;
  data?: { object?: StripeCheckoutSession & StripeChargeObject };
};

type StripeRefundResponse = {
  id?: string;
  status?: string;
};

type StripeErrorResponse = {
  error?: { message?: string; code?: string };
};

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  /**
   * Stripe accepts partial refunds on every payment method it settles
   * for us — the admin refund action may allow any amount up to the
   * remaining refundable balance.
   */
  readonly capabilities = { partialRefunds: true } as const;
  private readonly baseUrl: string;

  constructor(private readonly config: StripeConfig) {
    if (!config.secretKey) {
      throw new Error("StripePaymentProvider: secretKey is required");
    }
    if (!config.webhookSecret) {
      throw new Error("StripePaymentProvider: webhookSecret is required");
    }
    this.baseUrl = config.baseUrl ?? DEFAULT_STRIPE_BASE_URL;
  }

  /**
   * Stripe's API is form-encoded, not JSON — nested fields use
   * bracket notation (`line_items[0][price_data][currency]`).
   */
  private async post(
    path: string,
    fields: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  private async errorMessage(res: Response): Promise<string> {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as StripeErrorResponse;
      if (parsed.error?.message) return parsed.error.message.slice(0, 500);
    } catch {
      /* not JSON — fall through to raw text */
    }
    return text.slice(0, 500) || `Stripe request failed (${res.status})`;
  }

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    const referenceId =
      input.orderNumber ?? input.metadata?.orderNumber ?? input.orderId;
    try {
      const res = await this.post(
        "/v1/checkout/sessions",
        {
          mode: "payment",
          // Card ONLY: this provider is routed for method 'card' — the
          // Thai rails (PromptPay) stay on Beam, so Stripe's dashboard
          // defaults must not quietly add other methods here.
          "payment_method_types[0]": "card",
          // The customer lands back on the order page either way; the
          // page polls order status, so success/cancel share one URL.
          success_url: input.returnUrl,
          cancel_url: input.returnUrl,
          // Order NUMBER — echoed on the session object, the webhook's
          // pre-payment join key (mirrors Beam's order.referenceId).
          client_reference_id: referenceId,
          "metadata[orderId]": input.orderId,
          customer_email: input.customerEmail,
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": input.currency.toLowerCase(),
          // Smallest currency unit (satang) — passes through untouched.
          "line_items[0][price_data][unit_amount]": String(input.amount),
          "line_items[0][price_data][product_data][name]": input.description,
        },
        // Same scope as Beam's link key: retries of the same order
        // replay the original session instead of minting a second one.
        input.orderId,
      );
      if (!res.ok) {
        return {
          ok: false,
          code: `HTTP_${res.status}`,
          message: await this.errorMessage(res),
        };
      }
      const body = (await res.json()) as StripeCheckoutSession;
      if (!body.id || !body.url) {
        return {
          ok: false,
          code: "NO_SESSION_IN_RESPONSE",
          message: "Stripe checkout session response carried no id/url",
        };
      }
      return { ok: true, providerChargeId: body.id, paymentUrl: body.url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "NETWORK_ERROR", message };
    }
  }

  /**
   * POST /v1/refunds. The stored providerChargeId is the
   * payment_intent (pi_...) after markPaid's id swap; a raw charge id
   * (ch_...) is accepted too for robustness. `amount` is in the
   * smallest unit and always sent explicitly — omitting it means
   * "refund everything", which must never happen by accident.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const id = input.providerChargeId;
    const idField = id.startsWith("ch_") ? "charge" : "payment_intent";
    if (id.startsWith("cs_")) {
      // The session id was never swapped for the payment_intent —
      // either the order was never paid or the webhook never landed.
      return {
        ok: false,
        code: "NO_PAYMENT_INTENT",
        message:
          "Stored charge id is a Checkout Session (cs_...) — the order has no settled payment_intent to refund",
      };
    }
    try {
      const res = await this.post("/v1/refunds", {
        [idField]: id,
        amount: String(input.amount),
        ...(input.reason ? { "metadata[reason]": input.reason } : {}),
      });
      if (!res.ok) {
        return {
          ok: false,
          code: `HTTP_${res.status}`,
          message: await this.errorMessage(res),
        };
      }
      const body = (await res.json()) as StripeRefundResponse;
      if (!body.id) {
        return {
          ok: false,
          code: "NO_REFUND_ID_IN_RESPONSE",
          message: "Stripe refund response carried no id",
        };
      }
      if (body.status === "failed" || body.status === "canceled") {
        return {
          ok: false,
          code: "REFUND_FAILED",
          message: `Stripe refund ${body.id} is ${body.status}`,
        };
      }
      return { ok: true, providerRefundId: body.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "NETWORK_ERROR", message };
    }
  }

  /**
   * Verify a `Stripe-Signature` header: `t=<unix>,v1=<hex>[,v1=...]`.
   * The signed payload is `${t}.${rawBody}` — binding the timestamp
   * into the HMAC is what makes the staleness check trustworthy.
   * Multiple v1 entries are legal (secret rotation); any match passes.
   */
  async verifyWebhook(
    rawBody: string,
    signature: string,
  ): Promise<WebhookVerifyResult> {
    if (!signature) {
      return {
        ok: false,
        code: "MISSING_SIGNATURE",
        message: "Stripe-Signature header absent",
      };
    }
    const parts = signature.split(",").map((p) => p.trim());
    const timestamp = parts.find((p) => p.startsWith("t="))?.slice("t=".length);
    const candidates = parts
      .filter((p) => p.startsWith("v1="))
      .map((p) => p.slice("v1=".length));
    if (!timestamp || candidates.length === 0) {
      return {
        ok: false,
        code: "MALFORMED_SIGNATURE",
        message: "Stripe-Signature header carries no t=/v1= pair",
      };
    }
    const expected = await hmacSha256Hex(
      this.config.webhookSecret,
      `${timestamp}.${rawBody}`,
    );
    if (!candidates.some((c) => timingSafeEqual(expected, c))) {
      return { ok: false, code: "INVALID_SIGNATURE", message: "HMAC mismatch" };
    }
    // Staleness AFTER authenticity: only a genuinely-signed timestamp
    // is worth trusting enough to compare against the clock.
    const ageSeconds = Math.abs(
      Date.now() / 1000 - Number.parseInt(timestamp, 10),
    );
    if (
      !Number.isFinite(ageSeconds) ||
      ageSeconds > SIGNATURE_TOLERANCE_SECONDS
    ) {
      return {
        ok: false,
        code: "SIGNATURE_TOO_OLD",
        message: `Webhook timestamp outside the ${SIGNATURE_TOLERANCE_SECONDS}s replay window`,
      };
    }
    let event: StripeEventEnvelope;
    try {
      event = JSON.parse(rawBody) as StripeEventEnvelope;
    } catch {
      return { ok: false, code: "INVALID_JSON", message: "Body is not JSON" };
    }
    if (typeof event !== "object" || event === null) {
      return {
        ok: false,
        code: "MALFORMED_PAYLOAD",
        message: "Body is not a JSON object",
      };
    }
    const session = event.data?.object ?? {};

    // Dashboard/API refunds arrive as `charge.refunded` carrying a
    // Charge object. Normalized to "refunded" so the webhook route
    // records them in the adjustments ledger — silently no-op'ing
    // them would leave the books wrong forever. The individual
    // re_... id and amount come from `refunds.data[0]` (most recent
    // first) when the API version includes the list; otherwise the
    // route derives the delta from the cumulative `amount_refunded`
    // in `raw`.
    if (event.type === "charge.refunded") {
      const latestRefund = session.refunds?.data?.[0];
      return {
        ok: true,
        eventType: event.type,
        // payment_intent joins back to the order (markPaid persisted
        // it); the ch_... id is only a last-resort fallback.
        providerChargeId: session.payment_intent ?? session.id ?? "",
        status: "refunded",
        amount: latestRefund?.amount,
        providerRefundId: latestRefund?.id,
        raw: event,
      };
    }

    // A COMPLETED-and-paid checkout session confirms money — either
    // the synchronous `completed` event or, for delayed-notification
    // payment methods, `async_payment_succeeded` (without which a
    // delayed payment would settle and the order stay pending
    // forever). Everything else (session.expired, novel types)
    // degrades to "pending" so the route logs-and-200s — same
    // no-retry-storm policy as Beam. An expired session is
    // deliberately NOT "failed": the customer can mint a fresh
    // session from the order page, so cancelling the order (what
    // "failed" triggers) would be wrong.
    const isPaidSessionEvent =
      (event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded") &&
      (session.payment_status === undefined ||
        session.payment_status === "paid");
    const status: "succeeded" | "pending" = isPaidSessionEvent
      ? "succeeded"
      : "pending";
    return {
      ok: true,
      eventType: event.type ?? "",
      // payment_intent preferred — refunds need it; the session id is
      // the pre-payment fallback matching what checkout stored.
      providerChargeId: session.payment_intent ?? session.id ?? "",
      referenceId: session.client_reference_id ?? undefined,
      status,
      amount: session.amount_total ?? undefined,
      raw: event,
    };
  }
}
