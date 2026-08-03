/**
 * /lookup — order lookup form for guests.
 *
 * Enter order number + email → 302 to /order/[orderNumber]?email=...
 * The order page validates the (orderNumber, email) tuple before
 * revealing details, so this route is safe to leave unauthenticated.
 */
import { fail, redirect } from "@sveltejs/kit";
import { localePath, toLocale } from "$lib/i18n";
import { OrderService } from "$plugins/shop/order-service";
import type { Actions } from "./$types";

export const actions: Actions = {
  default: async ({ request, platform, params }) => {
    const env = platform?.env;
    // Errors are returned as CODES and mapped to Paraglide messages in
    // the page, so the visitor sees them in their own locale — the whole
    // reason this route moved under /[locale]/ (#141).
    if (!env) return fail(503, { errorCode: "platform" as const });
    const fd = await request.formData();
    const orderNumber = String(fd.get("orderNumber") ?? "").trim();
    const email = String(fd.get("email") ?? "").trim();
    if (!orderNumber || !email) {
      return fail(400, { errorCode: "required" as const });
    }
    const svc = new OrderService(env.DB);
    const order = await svc.getOrderByNumber(orderNumber, email);
    if (!order) {
      return fail(404, { errorCode: "not_found" as const });
    }
    throw redirect(
      302,
      localePath(
        toLocale(params.locale),
        `/order/${orderNumber}?email=${encodeURIComponent(email)}`,
      ),
    );
  },
};
