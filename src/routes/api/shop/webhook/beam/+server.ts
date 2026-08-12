/**
 * POST /api/shop/webhook/beam — Beam charge status webhook.
 *
 * Beam posts here on every charge state transition. Real payloads are
 * FLAT (#151) — {chargeId, referenceId, status, amount, currency} —
 * with the event name in the `X-Beam-Event` header, which we read and
 * hand to verifyWebhook. We verify the HMAC-SHA256 signature
 * (constant-time) and dispatch:
 *   - succeeded → OrderService.markPaid
 *   - failed → OrderService.markCancelled
 *   - refunded → recorded via a separate admin-triggered path
 *   - pending (incl. any unknown/novel status) → log + 200 no-op, so
 *     a signed-but-unfamiliar event never triggers a Beam retry storm
 *
 * Order matching is two-step (see ./lookup.ts): by provider_charge_id
 * first, then by the order number Beam echoes as `referenceId` —
 * checkout stored the payment-LINK id, so the first payment webhook's
 * real chargeId can only join via referenceId. On markPaid we persist
 * that real chargeId into provider_charge_id so refunds (and webhook
 * retries) have the actual charge id, not the link id.
 *
 * Signature header: `X-Beam-Signature`. Never trust the body without
 * verifying — Beam includes a signature specifically to prevent
 * spoofed cancellations that would release inventory.
 *
 * ── Refund events ───────────────────────────────────────────────────
 * Per https://docs.beamcheckout.com/webhook-event-types, "refunded"
 * NEVER appears as a charge status. Refunds arrive as separate
 * `refund.succeeded` / `refund.failed` events whose payload is
 * {refundId, chargeId, referenceId, amount, status, refundReason, …}.
 * Those are branched on EVENT NAME before the charge-status switch —
 * a refund.succeeded body normalizes to status "succeeded" and would
 * otherwise be misread as a payment. Ledger idempotency is keyed
 * `beam:refund:<refundId>`, plus a providerRefundId dedupe so an
 * admin-initiated refund (already recorded under the form nonce) is
 * not double-counted when Beam echoes it back.
 */
import { json } from "@sveltejs/kit";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { OrderService } from "$plugins/shop/order-service";
import { sendOrderReceipt } from "$plugins/shop/email";
import { notifyNewOrder } from "$plugins/shop/notify";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, desc } from "drizzle-orm";
import {
  shopCarts,
  shopOrderAdjustments,
  shopOrders,
} from "$plugins/shop/schema-cart";
import { track, buildEventContext } from "$lib/server/analytics/track";
import { dispatchEvent } from "$lib/server/webhooks";
import { ShopValidationError } from "$plugins/shop/service";
import { findOrderForWebhook } from "./lookup";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({
  request,
  platform,
  url,
  locals,
}) => {
  const env = platform?.env;
  if (!env) return json({ ok: false, code: "NO_PLATFORM" }, { status: 503 });

  const provider = await resolveProviderForRequest(env, "beam");
  if (!provider) {
    return json(
      { ok: false, code: "PROVIDER_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("x-beam-signature") ?? "";
  // The event name rides in a request header, not the body (#151).
  const eventName = request.headers.get("x-beam-event") ?? undefined;
  const rawBody = await request.text();

  const verified = await provider.verifyWebhook(rawBody, signature, eventName);
  if (!verified.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.webhook] beam verify failed: ${verified.code} ${verified.message}`,
    );
    return json({ ok: false, code: verified.code }, { status: 400 });
  }

  // Pending covers the initial state AND any unknown/novel status the
  // adapter normalized (#151). Nothing to do either way — 200 before
  // the order lookup so an unmatchable-but-signed event can't 503-loop.
  if (verified.status === "pending") {
    // eslint-disable-next-line no-console
    console.log(
      `[shop.webhook] beam event '${verified.eventType || "?"}' status pending — no-op`,
    );
    return json({ ok: true, orderStatus: "pending" });
  }

  // Two-step match: real charge id first (populated after the first
  // markPaid), then the order number Beam echoes as referenceId (the
  // only key the FIRST payment webhook shares with checkout, which
  // stored the payment-link id). Logic lives in ./lookup.ts for tests.
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
      // Signed and well-formed but carrying no join key at all —
      // retrying can never help, so 200 to stop Beam's retries.
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.webhook] beam event '${verified.eventType || "?"}' has no chargeId or referenceId — acknowledged without action`,
      );
      return json({ ok: true, orderStatus: verified.status, matched: false });
    }
    // Webhook can arrive before attachProviderCharge lands (Beam
    // async redirect flow, network reorder). Return 5xx so Beam
    // RETRIES — a 200 here would silently swallow the succeeded
    // event and leave the order pending forever with the customer
    // charged. Beam's retry cadence (a few minutes) gives
    // attachProviderCharge time to land.
    return json({ ok: false, code: "ORDER_NOT_FOUND_YET" }, { status: 503 });
  }

  // #113: lifecycle transitions inside the service emit domain events
  // (order.paid / order.cancelled / order.refunded) through the core
  // webhook dispatcher. Fire-and-forget — a slow subscriber must never
  // delay Beam's 200.
  const orderSvc = new OrderService(env.DB, {
    emitEvent: (event, payload) =>
      void dispatchEvent(locals.content, { event, payload }),
  });

  // Refund lifecycle events — branched BEFORE the charge-status
  // switch (see module docblock): the payload `status` here is the
  // REFUND's, so a refund.succeeded would otherwise fall into the
  // "succeeded" case and be marked as a payment. Belt and braces: a
  // body carrying a refundId is a refund payload even if the
  // X-Beam-Event header was dropped by a proxy — routing it off the
  // header alone would let exactly that markPaid misread through
  // (CAS no-op, refund silently lost).
  // AUDIT F3 — the old guard was `startsWith("refund.") || providerRefundId`,
  // which leaked one case: header dropped AND refundId absent or "".
  // BeamWebhookBody.refundId is optional and unvalidated, so "" is
  // falsy; a refund.succeeded body normalizes to status "succeeded"
  // and fell straight into `case "succeeded"` → markPaid. On an
  // already-paid order the CAS no-ops, so the customer isn't harmed —
  // but the REFUND IS SILENTLY SWALLOWED (never written to the ledger)
  // and Beam gets a 200, so it never retries. On a pending order it
  // would mark the order PAID off a refund event.
  //
  // Fix, in two layers:
  //  1. Widen the fingerprint. A body carrying `refundReason` is a
  //     refund payload per Beam's documented refund shape
  //     ({refundId, chargeId, referenceId, amount, status,
  //     refundReason}), as is one whose status is a refund state.
  //  2. Backstop with a RETRYABLE 503 below when the header is missing
  //     and the body carries no fingerprint at all. Guessing is what
  //     caused the bug; a 503 makes Beam redeliver (headers included)
  //     instead of us silently mis-routing money.
  const rawBody_ = verified.raw as
    | { refundReason?: unknown; refundId?: unknown; status?: unknown }
    | undefined;
  const bodyStatus =
    typeof rawBody_?.status === "string" ? rawBody_.status.toLowerCase() : "";
  const looksLikeRefundBody =
    Boolean(verified.providerRefundId) ||
    // Non-empty refundId even if the adapter didn't surface it.
    (typeof rawBody_?.refundId === "string" && rawBody_.refundId.length > 0) ||
    typeof rawBody_?.refundReason === "string" ||
    bodyStatus.startsWith("refund");
  const eventType = verified.eventType ?? "";
  if (eventType.startsWith("refund.") || looksLikeRefundBody) {
    if (verified.status !== "succeeded") {
      // refund.failed (or a novel refund state): the ledger records
      // only settled money. The admin sees the failure in Beam's
      // dashboard; log without PII and acknowledge.
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.webhook] beam '${verified.eventType}' for ${order.orderNumber} (refund ${verified.providerRefundId ?? "?"}) status ${verified.status} — no ledger change`,
      );
      return json({ ok: true, orderStatus: verified.status, refund: true });
    }
    const refundId = verified.providerRefundId;
    // Dedupe by provider refund id FIRST: an admin-initiated refund
    // was already recorded (under the form-nonce idempotency key) and
    // persisted this same providerRefundId — the webhook is its echo.
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
    // AUDIT F5 — the idempotency key must not collapse distinct
    // refunds. When refundId is absent the old key fell back to
    // `beam:refund:<providerChargeId>`, which is CONSTANT per order:
    // two genuine partial refunds produced the SAME key with DIFFERENT
    // amounts, so the second hit recordRefund's body-fingerprint check,
    // threw ShopValidationError, got caught-and-200'd below, and was
    // permanently lost — Beam never retries a 200.
    //
    // Beam's payload carries no per-event id to key on (unlike Stripe's
    // event `id`), so there is nothing safe to substitute. Fail loudly
    // and RETRYABLY instead of silently mis-recording: a redelivery may
    // carry the refundId, and a persistent failure is visible to an
    // operator who can reconcile in the Beam dashboard.
    if (!refundId) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.webhook] beam refund event for ${order.orderNumber} carries no refundId — cannot key the ledger safely (a charge-id key would collapse distinct partial refunds); returning 503 for redelivery`,
      );
      return json({ ok: false, code: "REFUND_ID_MISSING" }, { status: 503 });
    }
    const remaining = await orderSvc.refundableSatang(order.id);
    // The event's amount is authoritative for Beam-initiated refunds;
    // cap at the ledger's remaining balance so a replay/echo can never
    // push the ledger past the order total.
    const amountSatang = Math.min(verified.amount ?? remaining, remaining);
    if (amountSatang <= 0) {
      return json({ ok: true, orderStatus: "refunded", replayed: true });
    }
    try {
      await orderSvc.recordRefund({
        orderId: order.id,
        amountSatang,
        reason: "Beam-initiated refund",
        kind: amountSatang >= remaining ? "refund_full" : "refund_partial",
        // Guaranteed non-empty by the guard above — no charge-id
        // fallback, which would collapse distinct partial refunds
        // onto one key (audit F5).
        idempotencyKey: `beam:refund:${refundId}`,
        providerRefundId: refundId,
      });
    } catch (err) {
      if (err instanceof ShopValidationError) {
        // Ledger already caught up (concurrent admin refund or a
        // replayed key). Retrying can never help — acknowledge.
        // eslint-disable-next-line no-console
        console.warn(
          `[shop.webhook] beam refund for ${order.orderNumber} not recorded: ${err.message}`,
        );
      } else {
        throw err;
      }
    }
    return json({ ok: true, orderStatus: "refunded" });
  }

  // AUDIT F3 layer 2 — money-moving events REQUIRE the event header.
  //
  // By here the body carries no refund fingerprint, but the header is
  // also gone, so we cannot actually tell a `charge.succeeded` from a
  // `refund.succeeded` whose refundId/refundReason were absent. The
  // pre-fix code guessed "payment", which is the unsafe guess: it
  // marks orders paid off refund events and swallows refunds with a
  // 200 that stops Beam retrying.
  //
  // 503 instead — Beam RETRIES, and a retry that carries the header
  // resolves correctly. A transport that permanently strips the header
  // surfaces as loud, visible retry failure (an operator can fix the
  // proxy) rather than as silently wrong books. Deliberately NOT
  // applied to the pending path, which no-ops before the lookup and
  // moves no money either way.
  if (!eventType) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.webhook] beam webhook for ${order.orderNumber} arrived without X-Beam-Event and carries no refund fingerprint — refusing to guess payment vs refund; returning 503 for redelivery`,
    );
    return json({ ok: false, code: "MISSING_EVENT_HEADER" }, { status: 503 });
  }

  switch (verified.status) {
    case "succeeded": {
      const paid = await orderSvc.markPaid({
        orderId: order.id,
        // Persist the webhook's REAL charge id over the payment-link id
        // checkout stored (#151) — refunds need the charge id. On the
        // rare event without one, keep whatever is already stored.
        providerChargeId:
          verified.providerChargeId || (order.providerChargeId ?? ""),
      });
      // The SETTLING provider is the source of truth for providerName
      // (mirrors the Stripe route): a crossed retry can leave the
      // order stamped with the OTHER provider, and refunds dispatch on
      // providerName — mislabeling guarantees a wrong-provider 4xx.
      if ((order.providerName ?? "beam") !== "beam") {
        await db
          .update(shopOrders)
          .set({ providerName: "beam", updatedAt: new Date().toISOString() })
          .where(eq(shopOrders.id, order.id));
      }
      // Fire the receipt email. Never awaited-blocking — Beam should
      // get its 200 fast, and email delivery is best-effort. Silent
      // no-op when Resend isn't configured. Gated on the CAS winner
      // (justPaid) like the operator notification below: webhook
      // RETRIES land here too, and each one used to re-send the
      // customer their receipt.
      if (paid.justPaid) {
        sendOrderReceipt(env, paid).catch(() => {
          /* email module already logs failures */
        });
      }
      // C4: operator notification (email + LINE Notify) — winner-only
      // via markPaid's CAS flag, so Beam retries never re-notify. Both
      // channels are best-effort and must never fail the webhook; the
      // settings read is wrapped for the same reason.
      if (paid.justPaid) {
        void (async () => {
          const settings = await locals.content.getSettings().catch(() => null);
          await notifyNewOrder(env, paid, {
            notifyEmail: settings?.shopNotifyEmail ?? null,
          });
        })().catch(() => {
          /* notify module already logs failures */
        });
      }
      // Fire analytics purchase event. Look up the cart that was
      // ordered to reuse the visitor's session id — otherwise the
      // funnel (product_view → add_to_cart → begin_checkout →
      // purchase) can't join by session_id and conversion looks 0.
      // Also reads the discountCode field which v3.4 federation
      // repurposes as `attribution:<articleId>` for article →
      // purchase attribution tracking. Real discountCode ships in
      // v3.5 with its own table.
      const cartRow = await drizzle(env.DB)
        .select({
          sessionId: shopCarts.sessionId,
          discountCode: shopCarts.discountCode,
        })
        .from(shopCarts)
        .where(
          and(eq(shopCarts.email, paid.email), eq(shopCarts.status, "ordered")),
        )
        .orderBy(desc(shopCarts.updatedAt))
        .limit(1)
        .get();
      const sessionIdForFunnel = cartRow?.sessionId ?? paid.id;
      let attributedArticleId: string | undefined;
      let discountRedemption: { discountId: string; code: string } | undefined;
      if (cartRow?.discountCode?.startsWith("attribution:")) {
        attributedArticleId = cartRow.discountCode.slice("attribution:".length);
      } else if (cartRow?.discountCode?.includes(":")) {
        // v3.5 format: `<discountId>:<code>` stashed by checkout/start
        const [id, ...rest] = cartRow.discountCode.split(":");
        if (id && rest.length > 0) {
          discountRedemption = { discountId: id, code: rest.join(":") };
        }
      }
      // v3.5 record discount redemption on payment success. Idempotent
      // via composite PK — webhook retries insert nothing new.
      if (discountRedemption && paid.discountSatang > 0) {
        try {
          const { recordRedemption } =
            await import("$plugins/shop/discount-service");
          await recordRedemption(env.DB, {
            discountId: discountRedemption.discountId,
            orderId: paid.id,
            userId: paid.userId ?? null,
            userEmail: paid.email,
            amountSatang: paid.discountSatang,
          });
        } catch {
          /* redemption tracking is best-effort — never fail an order over it */
        }
      }
      await track(
        env.DB,
        "purchase",
        {
          orderId: paid.id,
          orderNumber: paid.orderNumber,
          totalSatang: paid.totalSatang,
          itemCount: paid.items.reduce((s, i) => s + i.quantity, 0),
          ...(attributedArticleId ? { attributedArticleId } : {}),
        },
        buildEventContext({
          url,
          request,
          sessionId: sessionIdForFunnel,
          userId: paid.userId ?? null,
          locale: "en",
        }),
      );
      break;
    }
    case "failed":
      await orderSvc.markCancelled({ orderId: order.id });
      break;
    case "refunded": {
      // DEFENSIVE ONLY: per the official event list
      // (https://docs.beamcheckout.com/webhook-event-types) a charge
      // status is never "refunded" — refunds arrive as refund.* events
      // handled above. Kept so a novel/undocumented payload degrades
      // to the old remaining-balance recording instead of being lost.
      const remaining = await orderSvc.refundableSatang(order.id);
      if (remaining > 0) {
        try {
          await orderSvc.recordRefund({
            orderId: order.id,
            amountSatang: remaining,
            reason: "Beam-initiated refund",
            kind: "refund_full",
            // AUDIT F5: charge-id keying is only safe here because this
            // branch records the FULL remaining balance — it is
            // by construction a once-per-order operation (a second
            // delivery finds remaining === 0 and skips), so unlike the
            // refund.* path there are no distinct amounts to collapse.
            // Suffixed `:full` to keep it in a separate key namespace
            // from the refundId-keyed rows above.
            idempotencyKey: `beam:refund:${
              verified.providerChargeId || order.providerChargeId || order.id
            }:full`,
          });
        } catch (err) {
          if (err instanceof ShopValidationError) {
            // Ledger already caught up (concurrent admin refund, or a
            // replayed key from an earlier partial state). Retrying
            // can never help — acknowledge instead of 500-looping.
            // eslint-disable-next-line no-console
            console.warn(
              `[shop.webhook] beam refund echo for ${order.orderNumber} not recorded: ${err.message}`,
            );
          } else {
            throw err;
          }
        }
      }
      break;
    }
    // "pending" is acknowledged before the order lookup — by here the
    // status union has narrowed to succeeded | failed | refunded.
  }

  return json({ ok: true, orderStatus: verified.status });
};
