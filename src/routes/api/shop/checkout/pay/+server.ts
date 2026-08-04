/**
 * POST /api/shop/checkout/pay — create a payment charge for a pending order.
 *
 * Body: { orderId: string }
 * Returns: { paymentUrl?: string, qrCodeUrl?: string, providerChargeId }
 *
 * Two-step separation from /checkout/start lets the storefront show
 * a summary + address review before locking in the payment.
 */
import { error, json } from "@sveltejs/kit";
import { OrderService } from "$plugins/shop/order-service";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { requireSameOrigin } from "$lib/server/http/same-origin";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform, url }) => {
  // Checkout creates orders and initiates charges — the highest-value
  // state change in the app, and it had no provenance check at all
  // while the lower-stakes cart routes did.
  const originGuard = requireSameOrigin(request, url);
  if (originGuard) return originGuard;
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
  } | null;
  if (!body?.orderId) throw error(400, "orderId required");

  const orderSvc = new OrderService(env.DB);
  const order = await orderSvc.getOrder(body.orderId);
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

  const charge = await provider.createCharge({
    orderId: order.id,
    // Beam sends this as `order.referenceId` and echoes it in every
    // webhook — the join key that lets the first payment webhook find
    // the order before a real charge id exists (#151).
    orderNumber: order.orderNumber,
    description: `${order.orderNumber} — ${order.items.length} item(s)`,
    amount: order.totalSatang,
    currency: "THB",
    customerEmail: order.email,
    returnUrl: `${url.origin}/order/${order.orderNumber}`,
    metadata: { orderNumber: order.orderNumber },
  });

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
