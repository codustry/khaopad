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
 */
import { json } from "@sveltejs/kit";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { OrderService } from "$plugins/shop/order-service";
import { sendOrderReceipt } from "$plugins/shop/email";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, desc } from "drizzle-orm";
import { shopCarts, shopOrders } from "$plugins/shop/schema-cart";
import { track, buildEventContext } from "$lib/server/analytics/track";
import { findOrderForWebhook } from "./lookup";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform, url }) => {
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

  const orderSvc = new OrderService(env.DB);
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
      // Fire the receipt email. Never awaited-blocking — Beam should
      // get its 200 fast, and email delivery is best-effort. Silent
      // no-op when Resend isn't configured.
      sendOrderReceipt(env, paid).catch(() => {
        /* email module already logs failures */
      });
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
    case "refunded":
      // Admin-triggered refunds land here as an echo. Marking already-
      // refunded orders as refunded is idempotent; a Beam-initiated
      // refund (rare) records a full refund adjustment.
      if (order.status !== "refunded") {
        await orderSvc.recordRefund({
          orderId: order.id,
          amountSatang: order.totalSatang,
          reason: "Beam-initiated refund",
          kind: "refund_full",
        });
      }
      break;
    // "pending" is acknowledged before the order lookup — by here the
    // status union has narrowed to succeeded | failed | refunded.
  }

  return json({ ok: true, orderStatus: verified.status });
};
