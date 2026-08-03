/**
 * /checkout — public checkout page.
 *
 * Shows a review of the cart with an email field. Submit triggers
 * POST /api/shop/checkout/start (reserves inventory + creates order),
 * then POST /api/shop/checkout/pay (creates Beam charge, returns URL).
 * Customer is redirected to Beam's payment page.
 *
 * If the cart is empty or expired, redirect back to /cart.
 */
import { error, redirect } from "@sveltejs/kit";
import { localePath, toLocale } from "$lib/i18n";
import { CartService } from "$plugins/shop/cart-service";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
  platform,
  cookies,
  locals,
  params,
}) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const sessionId = ensureCartSession(cookies);
  const svc = new CartService(env.DB);
  const cart = await svc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });
  const items = await svc.listCartItems(cart.id);
  if (items.length === 0)
    throw redirect(303, localePath(toLocale(params.locale), "/cart"));
  const subtotal = items.reduce(
    (sum, i) => sum + i.priceSatangAtAdd * i.quantity,
    0,
  );
  return {
    cart: {
      id: cart.id,
      status: cart.status,
      email: cart.email,
    },
    items,
    subtotalSatang: subtotal,
    // v3.2 ships no shipping calc + no tax lines yet — placeholders
    // for the checkout UI. Shipping + tax sub-PRs (3f-h) wire this up.
    shippingSatang: 0,
    taxSatang: 0,
    totalSatang: subtotal,
    userEmail: locals.user?.email ?? null,
  };
};
