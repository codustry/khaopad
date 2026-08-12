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
  QrChargeResult,
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

/**
 * In-page PromptPay QR expiry (charges-api `qrPromptPay.expiryTime`).
 * Shorter than the link TTL: the QR is rendered inline on a page the
 * customer is actively looking at, and the storefront polls order
 * status — a stale tab should get a fresh QR, not a 55-minute-old one.
 */
const QR_CHARGE_TTL_MS = 30 * 60 * 1000;

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
 * AUDIT F8 — the old `try { atob() } catch { raw string }` fallback was
 * UNREACHABLE for exactly the input it was written for. `atob` only
 * throws on characters outside the base64 alphabet; a plain-ASCII
 * secret like "mysecret123" is *alphabet-valid*, so atob decoded it to
 * garbage bytes WITHOUT throwing and the raw-string branch never fired.
 * The operator got permanent, silent signature failures with no
 * diagnostic. We now validate STRICTLY (alphabet + length + padding)
 * before decoding, and fall back to raw-string key material only when
 * the secret is definitively not base64 — the fallback the original
 * comment promised, now actually reachable.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True only for a well-formed canonical base64 string: valid alphabet,
 * length a multiple of 4, and padding only at the end. A plain-ASCII
 * passphrase fails at least one of these in almost every case (the
 * length check catches "mysecret123" at 11 chars), which is what makes
 * the raw-string fallback reachable again.
 */
export function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!BASE64_RE.test(value)) return false;
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}

async function hmacSha256Base64(
  base64Secret: string,
  body: string,
): Promise<string> {
  const enc = new TextEncoder();
  let decoded: Uint8Array;
  if (isStrictBase64(base64Secret)) {
    decoded = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
  } else {
    // Not base64 — use the raw string as key material. Beam's documented
    // secret IS base64, so this branch means a misconfigured secret;
    // warn loudly so the operator sees WHY every webhook 400s instead of
    // silently HMAC-ing with garbage bytes.
    // eslint-disable-next-line no-console
    console.warn(
      "[shop.beam] BEAM_WEBHOOK_SECRET is not valid base64 — using it as raw key material. Beam issues base64 secrets; if webhook verification fails, re-copy the secret from the Lighthouse dashboard.",
    );
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

/**
 * Response of a direct QR PromptPay charge, per the official Charges
 * API reference (https://docs.beamcheckout.com/charges/charges-api):
 * `encodedImage` lives at the TOP level of the response, alongside
 * `chargeId` and `actionRequired: "ENCODED_IMAGE"`, and its expiry
 * field is named `expiry`.
 *
 * The nested `paymentMethod.qrPromptPay.encodedImage` path is kept as
 * a FALLBACK only: the #156 reporter observed it live, so a Beam
 * deployment that still returns it must not break — but the documented
 * top-level shape wins.
 */
type BeamQrChargeResponse = {
  chargeId?: string;
  id?: string;
  actionRequired?: string;
  encodedImage?: { imageBase64Encoded?: string; expiry?: string };
  expiresAt?: string;
  paymentMethod?: {
    qrPromptPay?: {
      encodedImage?: { imageBase64Encoded?: string };
      expiresAt?: string;
    };
  };
};

/**
 * POST /api/v1/refunds response, per
 * https://docs.beamcheckout.com/refunds/refunds-api — the create call
 * returns only `{ refundId }`. The refund is created PENDING and moves
 * to SUCCEEDED asynchronously; the outcome arrives as a
 * `refund.succeeded` / `refund.failed` webhook, not in this response.
 */
type BeamRefundResponse = {
  refundId?: string;
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
  /**
   * Present on refund lifecycle events only. Per
   * https://docs.beamcheckout.com/webhook-event-types a refund arrives
   * as a SEPARATE `refund.succeeded` / `refund.failed` event whose
   * payload is {refundId, chargeId, referenceId, amount, status,
   * refundReason, ...} — "refunded" never appears as a CHARGE status.
   */
  refundId?: string;
  refundReason?: string;
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
          //
          // BOTH header spellings are sent deliberately: the official
          // docs specify `X-Beam-Idempotency-Key` (12h retention), but
          // the plain `Idempotency-Key` spelling has worked against
          // live Beam — belt and braces until one is proven ignored.
          "idempotency-key": input.orderId,
          "x-beam-idempotency-key": input.orderId,
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
   * In-page PromptPay QR — a DIRECT charge, not a payment link (#156).
   *
   * Direct charges are the one place `POST /api/v1/charges` fits our
   * checkout: the customer has already picked PromptPay in OUR UI, so
   * Beam's "one pre-chosen paymentMethod" requirement (the reason
   * createCharge uses payment links instead) is satisfied.
   *
   * CRITICAL SAFETY: this method NEVER throws — every failure returns
   * `ok: false` so the caller (checkout/pay) can fall back to the
   * hosted payment-link flow. A QR failure must never strand the
   * customer at checkout.
   *
   * Request/response shapes follow the official Charges API reference,
   * https://docs.beamcheckout.com/charges/charges-api:
   *
   *   - Request fields are TOP-LEVEL — {amount, currency, referenceId,
   *     returnUrl} — unlike payment links, where money nests under
   *     `order`. The method is chosen via
   *     paymentMethod.paymentMethodType: "QR_PROMPT_PAY" with an
   *     optional qrPromptPay.expiryTime.
   *   - Response carries `chargeId`, `actionRequired: "ENCODED_IMAGE"`,
   *     and a top-level `encodedImage: {imageBase64Encoded, expiry}`,
   *     which we prefix into a self-contained
   *     `data:image/png;base64,…` URI.
   */
  async createQrCharge(input: ChargeInput): Promise<QrChargeResult> {
    const referenceId =
      input.orderNumber ?? input.metadata?.orderNumber ?? input.orderId;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/charges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authHeader(),
          // `:qr` suffix keeps this key distinct from the payment-link
          // key (plain orderId) — the same order may legitimately try
          // QR first and fall back to a hosted link. Both spellings
          // sent — see createCharge for why.
          "idempotency-key": `${input.orderId}:qr`,
          "x-beam-idempotency-key": `${input.orderId}:qr`,
        },
        // Documented direct-charge shape (charges-api, link above):
        // top-level money fields — no `order` block here.
        body: JSON.stringify({
          amount: input.amount, // integer satang — never decimals
          currency: input.currency,
          referenceId,
          returnUrl: input.returnUrl,
          paymentMethod: {
            paymentMethodType: "QR_PROMPT_PAY",
            qrPromptPay: {
              expiryTime: new Date(Date.now() + QR_CHARGE_TTL_MS).toISOString(),
            },
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          code: `HTTP_${res.status}`,
          message:
            text.slice(0, 500) ||
            `Beam QR charge creation failed (${res.status})`,
        };
      }

      const body = (await res.json()) as BeamQrChargeResponse;
      // Documented location first (top-level `encodedImage`, see
      // charges-api), then the nested path a live deployment was seen
      // returning (#156). Missing from both → not a shape we
      // understand; fail soft so the caller falls back to the link.
      const imageBase64 =
        body.encodedImage?.imageBase64Encoded ??
        body.paymentMethod?.qrPromptPay?.encodedImage?.imageBase64Encoded;
      if (!imageBase64) {
        return {
          ok: false,
          code: "NO_QR_IN_RESPONSE",
          message:
            "Beam charge response carried no encodedImage.imageBase64Encoded (top-level or nested)",
        };
      }
      const providerChargeId = body.chargeId ?? body.id ?? "";
      if (!providerChargeId) {
        return {
          ok: false,
          code: "NO_CHARGE_ID_IN_RESPONSE",
          message: "Beam QR charge response carried no charge id",
        };
      }
      return {
        ok: true,
        providerChargeId,
        qrImage: `data:image/png;base64,${imageBase64}`,
        qrExpiresAt:
          body.encodedImage?.expiry ??
          body.paymentMethod?.qrPromptPay?.expiresAt ??
          body.expiresAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "NETWORK_ERROR", message };
    }
  }

  /**
   * POST /api/v1/refunds, per the official reference at
   * https://docs.beamcheckout.com/refunds/refunds-api:
   *
   *   - Body is camelCase: {chargeId, amount, reason}. There is NO
   *     currency field — the refund inherits the charge's currency.
   *   - `amount` omitted or 0 means "max refundable". We ALWAYS send
   *     the explicit amount our ledger authorised — a dropped field
   *     must never silently become a full refund.
   *   - Response is just {refundId}. The refund is created PENDING and
   *     settles asynchronously; the outcome arrives as a
   *     `refund.succeeded` / `refund.failed` webhook, which the
   *     webhook route records against this refundId.
   *   - PARTIAL REFUNDS ARE CARD-ONLY. Non-card charges (PromptPay QR,
   *     e-wallets) must be refunded in full in a single request — Beam
   *     4xxes a partial. We surface that constraint in the error
   *     mapping below rather than guessing at intent.
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
          chargeId: input.providerChargeId,
          amount: input.amount,
          reason: input.reason ?? "Merchant-initiated refund",
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        // Beam rejects a partial refund of a non-card charge with a
        // client error (refunds-api: "Partial refund is only supported
        // for CARD payment method charges"). The admin cannot see the
        // charge's method from here, so append the constraint to every
        // 4xx — the operator's fix is either a FULL refund or handling
        // it in the Beam dashboard, never a silent amount rewrite.
        const cardOnlyHint =
          res.status >= 400 && res.status < 500
            ? " Note: Beam supports partial refunds for CARD charges only — PromptPay/e-wallet charges must be refunded in full (https://docs.beamcheckout.com/refunds/refunds-api)."
            : "";
        return {
          ok: false,
          code: `HTTP_${res.status}`,
          message:
            (text.slice(0, 500) || `Beam refund failed (${res.status})`) +
            cardOnlyHint,
        };
      }
      const body = (await res.json()) as BeamRefundResponse;
      if (!body.refundId) {
        return {
          ok: false,
          code: "NO_REFUND_ID_IN_RESPONSE",
          message: "Beam refund response carried no refundId",
        };
      }
      return { ok: true, providerRefundId: body.refundId };
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
      // Present on refund.* events only (see BeamWebhookBody) — the
      // route keys refund idempotency on it: `beam:refund:<refundId>`.
      providerRefundId: parsed.refundId,
      raw: parsed,
    };
  }
}
