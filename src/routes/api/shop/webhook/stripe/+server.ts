/**
 * POST /api/shop/webhook/stripe — Stripe checkout webhook (#160 E-3).
 *
 * Mirrors the Beam route's shape with Stripe's mechanics:
 *   - Signature: `Stripe-Signature` header, `t=...,v1=...` HMAC-SHA256
 *     hex over `${t}.${rawBody}`, verified (constant-time, 5-minute
 *     replay window) inside StripePaymentProvider.verifyWebhook.
 *   - Only `checkout.session.completed` confirms money → markPaid.
 *     Everything else normalizes to "pending" and is acknowledged —
 *     an expired session is NOT a failure (the customer can mint a
 *     fresh session from the order page), so nothing here cancels.
 *
 * Order matching reuses the Beam route's two-step lookup: by
 * provider_charge_id first (checkout stored the session id cs_...;
 * retries after markPaid match the swapped-in payment_intent), then by
 * order number via `client_reference_id` — the pre-payment join key,
 * exactly like Beam's referenceId. On markPaid the session's
 * payment_intent (pi_...) is persisted over the session id because
 * refunds need it.
 *
 * Logging carries order numbers and event types only — never customer
 * email or addresses (no-PII policy, same as the Beam route).
 */
import { json } from "@sveltejs/kit";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { OrderService } from "$plugins/shop/order-service";
import { ShopValidationError } from "$plugins/shop/service";
import { sendOrderReceipt } from "$plugins/shop/email";
import { notifyNewOrder } from "$plugins/shop/notify";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { shopOrderAdjustments, shopOrders } from "$plugins/shop/schema-cart";
import { track, buildEventContext } from "$lib/server/analytics/track";
import { dispatchEvent } from "$lib/server/webhooks";
import { findOrderForWebhook } from "../beam/lookup";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({
  request,
  platform,
  url,
  locals,
}) => {
  const env = platform?.env;
  if (!env) return json({ ok: false, code: "NO_PLATFORM" }, { status: 503 });

  const provider = await resolveProviderForRequest(env, "stripe");
  if (!provider) {
    return json(
      { ok: false, code: "PROVIDER_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature") ?? "";
  const rawBody = await request.text();

  const verified = await provider.verifyWebhook(rawBody, signature);
  if (!verified.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.webhook] stripe verify failed: ${verified.code} ${verified.message}`,
    );
    return json({ ok: false, code: verified.code }, { status: 400 });
  }

  // Anything that isn't a paid session or a refund — same
  // acknowledge-don't-bounce policy as Beam: a signed-but-unfamiliar
  // event must never make Stripe retry-storm.
  if (verified.status !== "succeeded" && verified.status !== "refunded") {
    // eslint-disable-next-line no-console
    console.log(
      `[shop.webhook] stripe event '${verified.eventType || "?"}' status ${verified.status} — no-op`,
    );
    return json({ ok: true, orderStatus: verified.status });
  }

  const db = drizzle(env.DB);
  const order = await findOrderForWebhook(
    {
      providerChargeId: verified.providerChargeId,
      referenceId: verified.referenceId,
    },
    {
      byProviderChargeId: (id) =>
        db
          .select()
          .from(shopOrders)
          .where(eq(shopOrders.providerChargeId, id))
          .limit(1)
          .get(),
      byOrderNumber: (orderNumber) =>
        db
          .select()
          .from(shopOrders)
          .where(eq(shopOrders.orderNumber, orderNumber))
          .limit(1)
          .get(),
    },
  );
  if (!order) {
    if (!verified.providerChargeId && !verified.referenceId) {
      // Signed and well-formed but with no join key — retrying can
      // never help, so 200 to stop Stripe's retries.
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.webhook] stripe event '${verified.eventType || "?"}' has no session/payment_intent or client_reference_id — acknowledged without action`,
      );
      return json({ ok: true, orderStatus: verified.status, matched: false });
    }
    if (verified.status === "refunded") {
      // A refund for an order we can't find will never become findable
      // by retrying — the join key (payment_intent) is persisted at
      // markPaid, long before any refund can exist. Acknowledge.
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.webhook] stripe charge.refunded matched no order (pi/ch lookup) — acknowledged without action`,
      );
      return json({ ok: true, orderStatus: "refunded", matched: false });
    }
    // The webhook can beat attachProviderCharge (Stripe fires fast on
    // test cards). 5xx so Stripe RETRIES — same reasoning as Beam.
    return json({ ok: false, code: "ORDER_NOT_FOUND_YET" }, { status: 503 });
  }

  const orderSvc = new OrderService(env.DB, {
    emitEvent: (event, payload) =>
      void dispatchEvent(locals.content, { event, payload }),
  });

  // Dashboard/API refunds (`charge.refunded`) — mirrors the Beam
  // route's refund.* handling: dedupe by the provider refund id
  // (re_...), record keyed `stripe:refund:<re_id>`, cap at the
  // remaining refundable balance.
  if (verified.status === "refunded") {
    const refundId = verified.providerRefundId;
    if (refundId) {
      const existing = await db
        .select({ id: shopOrderAdjustments.id })
        .from(shopOrderAdjustments)
        .where(eq(shopOrderAdjustments.providerRefundId, refundId))
        .limit(1)
        .get();
      if (existing) {
        return json({ ok: true, orderStatus: "refunded", replayed: true });
      }
    }
    const remaining = await orderSvc.refundableSatang(order.id);
    // Newer Stripe API versions omit the `refunds` list from the
    // charge object, leaving no per-refund amount — fall back to the
    // cumulative `amount_refunded` minus what the ledger already
    // holds. Either way the record is capped at the remaining balance.
    const cumulative = (
      verified.raw as {
        data?: { object?: { amount_refunded?: number } };
      }
    )?.data?.object?.amount_refunded;
    const recordedSoFar = order.totalSatang - remaining;
    const delta =
      typeof cumulative === "number" ? cumulative - recordedSoFar : remaining;
    const amountSatang = Math.min(verified.amount ?? delta, remaining);
    if (amountSatang <= 0) {
      return json({ ok: true, orderStatus: "refunded", replayed: true });
    }
    try {
      await orderSvc.recordRefund({
        orderId: order.id,
        amountSatang,
        reason: "Stripe-initiated refund",
        kind: amountSatang >= remaining ? "refund_full" : "refund_partial",
        idempotencyKey: `stripe:refund:${
          refundId || order.providerChargeId || order.id
        }`,
        providerRefundId: refundId,
      });
    } catch (err) {
      if (err instanceof ShopValidationError) {
        // Ledger already caught up (concurrent admin refund or a
        // replayed key). Retrying can never help — acknowledge.
        // eslint-disable-next-line no-console
        console.warn(
          `[shop.webhook] stripe refund for ${order.orderNumber} not recorded: ${err.message}`,
        );
      } else {
        throw err;
      }
    }
    return json({ ok: true, orderStatus: "refunded" });
  }

  const paid = await orderSvc.markPaid({
    orderId: order.id,
    // Persist the payment_intent over the session id checkout stored —
    // refunds need pi_..., not cs_.... On the rare event without one,
    // keep whatever is already stored.
    providerChargeId:
      verified.providerChargeId || (order.providerChargeId ?? ""),
  });
  // The SETTLING provider is the source of truth for providerName. A
  // crossed retry (Stripe session minted → customer retries with
  // PromptPay, order re-stamped beam → then completes the still-open
  // Stripe session) would otherwise leave a Stripe payment_intent on
  // an order labelled beam — and the admin refund action dispatches on
  // providerName, guaranteeing a wrong-provider 4xx.
  if ((order.providerName ?? "stripe") !== "stripe") {
    await db
      .update(shopOrders)
      .set({ providerName: "stripe", updatedAt: new Date().toISOString() })
      .where(eq(shopOrders.id, order.id));
  }
  // Receipt + operator notification: winner-only via markPaid's CAS
  // flag so Stripe retries never re-send. Both best-effort — a Resend
  // or LINE hiccup must never fail the webhook.
  if (paid.justPaid) {
    sendOrderReceipt(env, paid).catch(() => {
      /* email module already logs failures */
    });
    void (async () => {
      const settings = await locals.content.getSettings().catch(() => null);
      await notifyNewOrder(env, paid, {
        notifyEmail: settings?.shopNotifyEmail ?? null,
      });
    })().catch(() => {
      /* notify module already logs failures */
    });
  }
  // Purchase analytics. The Beam route joins the funnel through the
  // ordered cart's session id; card checkouts route through the same
  // storefront, so reuse would be identical — kept simpler here (order
  // id as session fallback) until funnel reports need the join.
  await track(
    env.DB,
    "purchase",
    {
      orderId: paid.id,
      orderNumber: paid.orderNumber,
      totalSatang: paid.totalSatang,
      itemCount: paid.items.reduce((s, i) => s + i.quantity, 0),
    },
    buildEventContext({
      url,
      request,
      sessionId: paid.id,
      userId: paid.userId ?? null,
      locale: "en",
    }),
  );

  return json({ ok: true, orderStatus: "succeeded" });
};
