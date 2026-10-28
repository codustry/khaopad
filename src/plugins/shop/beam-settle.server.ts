/**
 * Settle a Beam payment as PAID — the one path the webhook and the
 * direct status check (reconcile) both go through, so a paid order gets
 * exactly the same side effects however we learned of it (#218).
 *
 * Every side effect is gated on markPaid's CAS winner (`justPaid`) or is
 * idempotent on its own, so the two paths racing — webhook and poller
 * landing in the same second — still send one receipt, one operator
 * notification, and record one redemption.
 *
 * Extracted verbatim from the webhook route's `case "succeeded"` block
 * (v4.6.0); the comments below are the originals.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, desc } from "drizzle-orm";
import { OrderService } from "./order-service";
import { sendOrderReceipt } from "./email";
import { notifyNewOrder } from "./notify";
import { shopCarts, shopOrders } from "./schema-cart";
import { track, buildEventContext } from "$lib/server/analytics/track";
import { dispatchEvent } from "$lib/server/webhooks";
import type { ContentProvider } from "$lib/server/content/types";

type ShopOrderRow = typeof shopOrders.$inferSelect;

export type SettleContext = {
  env: App.Platform["env"];
  content: ContentProvider;
  url: URL;
  request: Request;
};

/**
 * Does what the provider reported actually pay THIS order? Applied to
 * both the signed webhook and the direct status check. Each field is
 * compared only when the provider reported it.
 */
export function checkSettlement(
  order: Pick<ShopOrderRow, "totalSatang" | "orderNumber">,
  reported: { amount?: number; referenceId?: string },
): { ok: true } | { ok: false; reason: string } {
  if (reported.amount !== undefined && reported.amount !== order.totalSatang) {
    return {
      ok: false,
      reason: `amount ${reported.amount} != order total ${order.totalSatang}`,
    };
  }
  if (
    reported.referenceId !== undefined &&
    reported.referenceId !== order.orderNumber
  ) {
    return {
      ok: false,
      reason: `reference ${reported.referenceId} != ${order.orderNumber}`,
    };
  }
  return { ok: true };
}

export async function settleBeamPayment(
  { env, content, url, request }: SettleContext,
  order: ShopOrderRow,
  providerChargeId: string,
) {
  const db = drizzle(env.DB);
  const orderSvc = new OrderService(env.DB, {
    emitEvent: (event, payload) =>
      void dispatchEvent(content, { event, payload }),
  });
  const paid = await orderSvc.markPaid({
    orderId: order.id,
    // Persist the webhook's REAL charge id over the payment-link id
    // checkout stored (#151) — refunds need the charge id. On the
    // rare event without one, keep whatever is already stored.
    providerChargeId: providerChargeId || (order.providerChargeId ?? ""),
  });
  if (!paid.justPaid && paid.status !== "paid") {
    // Money arrived for an order that is no longer payable (cancelled
    // by the reservation sweep, or refunded). markPaid ignores it, so
    // say so loudly: the operator must refund or reinstate by hand.
    console.error(
      `[shop.settle] PAYMENT ON ${paid.status.toUpperCase()} ORDER ${paid.orderNumber}: Beam reports it paid (charge ${providerChargeId || order.providerChargeId || "?"}) — refund or reinstate it`,
    );
    return paid;
  }
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
      const settings = await content.getSettings().catch(() => null);
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
  const cartRow = await db
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
      const { recordRedemption } = await import("./discount-service");
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
  // Winner-only (v4.6.0): with the webhook AND the status check able to
  // settle, an ungated purchase event would be counted twice.
  if (!paid.justPaid) return paid;
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
  return paid;
}
