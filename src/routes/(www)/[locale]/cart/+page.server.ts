/**
 * /cart — public cart page (locale-agnostic).
 *
 * Lists the current cart's items, price snapshot vs current price,
 * quantity controls, remove buttons, subtotal. Empty state links
 * back to /en/products. Checkout button posts to /checkout.
 */
import { error } from "@sveltejs/kit";
import { CartService } from "$plugins/shop/cart-service";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ platform, cookies, locals }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const sessionId = ensureCartSession(cookies);
  const svc = new CartService(env.DB);
  const cart = await svc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });
  const items = await svc.listCartItems(cart.id);
  const subtotal = items.reduce(
    (sum, i) => sum + i.priceSatangAtAdd * i.quantity,
    0,
  );
  const priceChanges = items.filter(
    (i) => i.priceSatangAtAdd !== i.currentPriceSatang,
  );
  return {
    cart: {
      id: cart.id,
      status: cart.status,
    },
    items,
    subtotalSatang: subtotal,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    priceChanges,
  };
};
