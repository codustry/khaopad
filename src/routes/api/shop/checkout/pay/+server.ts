/**
 * POST /api/shop/checkout/pay — create a payment charge for a pending order.
 *
 * Body: { orderId?: string, orderNumber?: string, method?: "promptpay" }
 * Returns (hosted link): { ok, providerChargeId, paymentUrl, extra }
 * Returns (in-page QR):  { ok, providerChargeId, orderNumber,
 *                          qr: { image, expiresAt } }
 *
 * Two-step separation from /checkout/start lets the storefront show
 * a summary + address review before locking in the payment.
 *
 * ── Pay-by-orderNumber (#157) ───────────────────────────────────────
 * `orderNumber` is accepted as an alternative to `orderId` so the
 * order-status page can offer a "Complete payment" retry — the customer
 * who abandoned the Beam page only holds the order NUMBER (it's in
 * their URL and receipt email), never the internal id.
 *
 * ACCEPTED RISK: an order number is a weak secret, so anyone holding it
 * can mint a payment link for that order. The blast radius is bounded:
 * the endpoint refuses any order not in `pending` status, the response
 * carries the payment URL and nothing else (no items, no email, no
 * address), and the minted link can only pay the order's OWN stored
 * total into the merchant's account — worst case, someone pays your
 * bill.
 */
import { error, json } from "@sveltejs/kit";
import { OrderService } from "$plugins/shop/order-service";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { requireSameOrigin } from "$lib/server/http/same-origin";
import { cookieName } from "$lib/paraglide/runtime";
import { DEFAULT_LOCALE, localePath, toLocale } from "$lib/i18n";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({
  request,
  platform,
  url,
  cookies,
}) => {
  // Checkout creates orders and initiates charges — the highest-value
  // state change in the app, and it had no provenance check at all
  // while the lower-stakes cart routes did.
  const originGuard = requireSameOrigin(request, url);
  if (originGuard) return originGuard;
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
    orderNumber?: string;
    method?: string;
  } | null;
  if (!body?.orderId && !body?.orderNumber) {
    throw error(400, "orderId or orderNumber required");
  }

  const orderSvc = new OrderService(env.DB);
  const order = body.orderId
    ? await orderSvc.getOrder(body.orderId)
    : await orderSvc.getOrderByNumber(body.orderNumber!);
  if (!order) throw error(404, "Order not found");
  if (order.status !== "pending") {
    return json(
      {
        ok: false,
        code: "ORDER_NOT_PENDING",
        message: `Order is ${order.status}, cannot charge`,
      },
      { status: 400 },
    );
  }

  const provider = await resolveProviderForRequest(
    env,
    order.providerName ?? "beam",
  );
  if (!provider) {
    return json(
      {
        ok: false,
        code: "PAYMENT_PROVIDER_NOT_CONFIGURED",
        message: `Payment provider '${order.providerName}' is not configured. Set BEAM_API_KEY + BEAM_WEBHOOK_SECRET (or your provider's equivalent) in wrangler.toml [vars] and redeploy.`,
      },
      { status: 503 },
    );
  }

  // Return URL: localized order page + ?payment=returned (#157). This
  // is an API route with no locale param, so the locale comes from the
  // Paraglide cookie (same pattern as the /cart redirect stub) — a
  // Thai customer now lands back on the THAI order page. The
  // ?payment=returned param is a UI hint that puts the page into its
  // "confirming payment" polling state; it carries no authority over
  // payment state — only the webhook writes `paid`.
  const locale = toLocale(cookies.get(cookieName) ?? DEFAULT_LOCALE);
  const returnUrl = `${url.origin}${localePath(
    locale,
    `/order/${order.orderNumber}`,
  )}?payment=returned`;

  const chargeInput = {
    orderId: order.id,
    // Beam sends this as `order.referenceId` and echoes it in every
    // webhook — the join key that lets the first payment webhook find
    // the order before a real charge id exists (#151).
    orderNumber: order.orderNumber,
    description: `${order.orderNumber} — ${order.items.length} item(s)`,
    amount: order.totalSatang,
    currency: "THB",
    customerEmail: order.email,
    returnUrl,
    metadata: { orderNumber: order.orderNumber },
  };

  // In-page PromptPay QR (#156) — duck-typed: only when the storefront
  // asked for it AND the provider implements it. ANY failure (throw,
  // ok:false, missing method) falls through to the hosted payment-link
  // path below — the customer must never be stranded because QR failed.
  if (
    body.method === "promptpay" &&
    typeof provider.createQrCharge === "function"
  ) {
    try {
      const qr = await provider.createQrCharge(chargeInput);
      if (qr.ok) {
        // Persisted exactly like createCharge's providerChargeId — the
        // webhook route swaps in the settled charge id via markPaid.
        await orderSvc.attachProviderCharge({
          orderId: order.id,
          providerChargeId: qr.providerChargeId,
        });
        return json({
          ok: true,
          providerChargeId: qr.providerChargeId,
          orderNumber: order.orderNumber,
          qr: { image: qr.qrImage, expiresAt: qr.qrExpiresAt },
        });
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.pay] QR charge failed for ${order.orderNumber} (${qr.code}), falling back to hosted link`,
      );
    } catch (err) {
      // Contract says createQrCharge never throws, but a duck-typed
      // third-party provider might — swallow and fall back.
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.pay] QR charge threw for ${order.orderNumber}, falling back to hosted link:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const charge = await provider.createCharge(chargeInput);

  if (!charge.ok) {
    return json(
      { ok: false, code: charge.code, message: charge.message },
      { status: 502 },
    );
  }

  await orderSvc.attachProviderCharge({
    orderId: order.id,
    providerChargeId: charge.providerChargeId,
  });

  return json({
    ok: true,
    providerChargeId: charge.providerChargeId,
    paymentUrl: charge.paymentUrl,
    extra: charge.extra,
  });
};
