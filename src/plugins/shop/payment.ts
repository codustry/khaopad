/**
 * Payment provider interface + registry.
 *
 * Providers are added to `providers` map at boot (see index.ts). v3.2
 * ships BeamCheckout only; #61 adds Stripe + Omise. Interface is
 * intentionally minimal — anything beyond create/refund/verify-webhook
 * goes into provider-specific extensions callers can dispatch by
 * `provider.name`.
 *
 * Money is always in the smallest unit: satang for THB, cents for USD.
 * Providers translate internally. The `Satang` type is not enforced
 * on the interface because a provider may charge in USD/JPY etc.
 * (call sites in v3.2 always pass Satang — enforcement stays there.)
 */
import type { Satang } from "./money";

export type ChargeInput = {
  /** Store-side reference. Providers store this as their `metadata.orderId`. */
  orderId: string;
  /**
   * Human-facing order number (e.g. "KP-2026-000123"). Providers that
   * echo a reference in webhooks (Beam's `order.referenceId`) send THIS
   * so the webhook can be joined back to the order before a charge id
   * exists (#151). Optional for compatibility; Beam falls back to
   * `metadata.orderNumber` then `orderId` when absent.
   */
  orderNumber?: string;
  /** Human-readable — printed on customer's statement / receipt. */
  description: string;
  amount: Satang | number;
  currency: string; // ISO 4217, e.g. "THB"
  /** Customer email — required by most providers for receipts. */
  customerEmail: string;
  /** Return URL after payment (BeamCheckout, Stripe Checkout, etc.). */
  returnUrl: string;
  /** Optional metadata forwarded to provider (surfaces on their dashboard). */
  metadata?: Record<string, string>;
};

export type ChargeResult =
  | {
      ok: true;
      /** Provider-native charge id (Beam chargeId, Stripe pi_..., etc.). */
      providerChargeId: string;
      /** URL to redirect the customer to for payment. */
      paymentUrl?: string;
      /** Extra provider-specific fields for the storefront (QR code URL, etc.). */
      extra?: Record<string, unknown>;
    }
  | {
      ok: false;
      /** Machine code — 'INVALID_AMOUNT', 'PROVIDER_DOWN', 'CARD_DECLINED', etc. */
      code: string;
      message: string;
    };

export type RefundInput = {
  providerChargeId: string;
  amount: Satang | number;
  currency: string;
  reason?: string;
};

export type RefundResult =
  | { ok: true; providerRefundId: string }
  | { ok: false; code: string; message: string };

export type WebhookVerifyResult =
  | {
      ok: true;
      eventType: string;
      /**
       * Provider-native charge id from the event. May be EMPTY ("") for
       * events that precede a charge (e.g. Beam payment-link lifecycle)
       * — callers should fall back to `referenceId` (#151).
       */
      providerChargeId: string;
      /**
       * Merchant-supplied reference echoed by the provider — for Beam
       * this is the order number sent as `order.referenceId` at
       * payment-link creation. The only join key available before a
       * charge exists (#151).
       */
      referenceId?: string;
      /** 'succeeded' | 'failed' | 'refunded' | 'pending' — normalized status. */
      status: "succeeded" | "failed" | "refunded" | "pending";
      /** Amount at the event moment (for partial refunds this may differ from original charge). */
      amount?: number;
      raw: unknown;
    }
  | { ok: false; code: string; message: string };

export interface PaymentProvider {
  readonly name: string;

  createCharge(input: ChargeInput): Promise<ChargeResult>;
  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Verify a webhook signature and normalize the event.
   * `signature` comes from the provider's header (Beam uses
   * `X-Beam-Signature`, Stripe uses `Stripe-Signature`, etc.).
   * `eventName` is for providers that carry the event name in a
   * separate request header rather than the body (Beam's
   * `X-Beam-Event`, #151) — the route reads it and passes it through.
   */
  verifyWebhook(
    rawBody: string,
    signature: string,
    eventName?: string,
  ): WebhookVerifyResult | Promise<WebhookVerifyResult>;
}

// ─── Registry ───────────────────────────────────────────────

const registeredProviders = new Map<string, PaymentProvider>();

/**
 * Register a payment provider at boot. Idempotent — a second call
 * with the same name overwrites (useful for tests). Providers are
 * only instantiated once, at the shop plugin's module load.
 */
export function registerPaymentProvider(provider: PaymentProvider): void {
  registeredProviders.set(provider.name, provider);
}

export function getPaymentProvider(name: string): PaymentProvider | null {
  return registeredProviders.get(name) ?? null;
}

export function listPaymentProviders(): PaymentProvider[] {
  return Array.from(registeredProviders.values());
}
