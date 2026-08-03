/**
 * /order/[orderNumber] — customer order status page.
 *
 * Guest and signed-in access. Guests without a session key need to
 * provide their email via ?email=... query param (or /lookup). This
 * matches Shopify's "order lookup" pattern — no account required to
 * check on your purchase.
 *
 * Displays: order summary, line items with snapshot titles, current
 * status (pending → paid → fulfilled → delivered → refunded),
 * shipping address if present.
 */
import { error } from "@sveltejs/kit";
import { OrderService } from "$plugins/shop/order-service";
import { clearCartSession } from "$plugins/shop/cart-cookie";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
  params,
  platform,
  url,
  cookies,
  locals,
}) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const email = url.searchParams.get("email");
  const orderSvc = new OrderService(env.DB);
  const order = await orderSvc.getOrderByNumber(
    params.orderNumber,
    // Signed-in users can view any order they own; anonymous requests
    // need the email as a lookup key.
    locals.user ? undefined : (email ?? undefined),
  );
  if (!order) throw error(404, "Order not found");

  // If the customer just paid, clear the cart cookie so their next
  // visit starts fresh. Idempotent — subsequent visits are no-ops.
  if (order.status === "paid") {
    clearCartSession(cookies);
  }

  // Parse shipping address JSON for the template.
  const shippingAddress = order.shippingAddressJson
    ? (JSON.parse(order.shippingAddressJson) as {
        name: string;
        line1: string;
        line2?: string;
        city: string;
        region?: string;
        postalCode: string;
        countryCode: string;
      })
    : null;

  return {
    order: {
      orderNumber: order.orderNumber,
      status: order.status,
      email: order.email,
      subtotalSatang: order.subtotalSatang,
      shippingSatang: order.shippingSatang,
      taxSatang: order.taxSatang,
      discountSatang: order.discountSatang,
      totalSatang: order.totalSatang,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      fulfilledAt: order.fulfilledAt,
      deliveredAt: order.deliveredAt,
      items: order.items.map((i) => ({
        id: i.id,
        titleSnapshot: i.titleSnapshot,
        skuSnapshot: i.skuSnapshot,
        priceSnapshotSatang: i.priceSnapshotSatang,
        quantity: i.quantity,
        lineSubtotalSatang: i.lineSubtotalSatang,
      })),
    },
    shippingAddress,
  };
};
