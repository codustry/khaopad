/**
 * POST /api/shop/webhook/beam — Beam charge status webhook.
 *
 * Beam posts here on every charge state transition. We verify the
 * HMAC-SHA256 signature (constant-time) and dispatch:
 *   - succeeded → OrderService.markPaid
 *   - failed → OrderService.markCancelled
 *   - refunded → recorded via a separate admin-triggered path
 *   - pending → no-op (initial state)
 *
 * Signature header: `X-Beam-Signature`. Never trust the body without
 * verifying — Beam includes a signature specifically to prevent
 * spoofed cancellations that would release inventory.
 */
import { json } from "@sveltejs/kit";
import { getPaymentProvider } from "$plugins/shop/payment";
import { OrderService } from "$plugins/shop/order-service";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { shopOrders } from "$plugins/shop/schema-cart";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform }) => {
  const env = platform?.env;
  if (!env) return json({ ok: false, code: "NO_PLATFORM" }, { status: 503 });

  const provider = getPaymentProvider("beam");
  if (!provider) {
    return json(
      { ok: false, code: "PROVIDER_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("x-beam-signature") ?? "";
  const rawBody = await request.text();

  const verified = await provider.verifyWebhook(rawBody, signature);
  if (!verified.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.webhook] beam verify failed: ${verified.code} ${verified.message}`,
    );
    return json({ ok: false, code: verified.code }, { status: 400 });
  }

  // Look up order by providerChargeId.
  const db = drizzle(env.DB);
  const order = await db
    .select()
    .from(shopOrders)
    .where(eq(shopOrders.providerChargeId, verified.providerChargeId))
    .limit(1)
    .get();
  if (!order) {
    // Webhook can arrive before attachProviderCharge lands (unlikely
    // with sequential flow, but possible). Return 200 so Beam doesn't
    // retry indefinitely — the customer's next pageload will retry
    // via /order/[number]?refresh=1.
    return json({ ok: true, code: "ORDER_NOT_FOUND_YET" });
  }

  const orderSvc = new OrderService(env.DB);
  switch (verified.status) {
    case "succeeded":
      await orderSvc.markPaid({
        orderId: order.id,
        providerChargeId: verified.providerChargeId,
      });
      break;
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
    case "pending":
      // No-op — initial state, order was just created.
      break;
  }

  return json({ ok: true, orderStatus: verified.status });
};
