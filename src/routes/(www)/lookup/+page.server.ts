/**
 * /lookup — order lookup form for guests.
 *
 * Enter order number + email → 302 to /order/[orderNumber]?email=...
 * The order page validates the (orderNumber, email) tuple before
 * revealing details, so this route is safe to leave unauthenticated.
 */
import { fail, redirect } from "@sveltejs/kit";
import { OrderService } from "$plugins/shop/order-service";
import type { Actions } from "./$types";

export const actions: Actions = {
  default: async ({ request, platform }) => {
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const orderNumber = String(fd.get("orderNumber") ?? "").trim();
    const email = String(fd.get("email") ?? "").trim();
    if (!orderNumber || !email) {
      return fail(400, { error: "Both fields are required" });
    }
    const svc = new OrderService(env.DB);
    const order = await svc.getOrderByNumber(orderNumber, email);
    if (!order) {
      return fail(404, {
        error: "No matching order found. Check the number and email.",
      });
    }
    throw redirect(
      302,
      `/order/${orderNumber}?email=${encodeURIComponent(email)}`,
    );
  },
};
