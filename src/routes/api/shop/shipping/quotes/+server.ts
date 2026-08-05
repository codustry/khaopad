/**
 * GET /api/shop/shipping/quotes — shipping quotes for the session cart.
 *
 * Query: ?country=<ISO-3166 alpha-2> — the destination the customer
 * has entered so far. Omitted/empty quotes against the fallback ("*")
 * zone, matching the engine's zone semantics.
 *
 * Quotes are computed server-side from the session cart's subtotal and
 * weight — the client never supplies amounts (#158's money-critical
 * property). The checkout UI shows these and posts the chosen
 * `methodId` back as `shippingMethod` to /api/shop/checkout/start,
 * which re-quotes and re-validates the id server-side.
 *
 * Returns: { ok: true, quotes: [{ methodId, label, amountSatang }] }
 * An empty `quotes` array means either no zone matches the country
 * ("we don't ship there") or the store has no shipping configured.
 */
import { error, json } from "@sveltejs/kit";
import { CartService } from "$plugins/shop/cart-service";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import { quoteShipping } from "$plugins/shop/shipping";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, cookies, url }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const country = (url.searchParams.get("country") ?? "").trim();
  const sessionId = ensureCartSession(cookies);
  const cartSvc = new CartService(env.DB);
  const cart = await cartSvc.ensureCart({ sessionId });
  const ctx = await cartSvc.getCartShippingContext(cart.id);

  const quotes = await quoteShipping(env.DB, {
    countryCode: country,
    totalWeightGrams: ctx.totalWeightGrams,
    subtotalSatang: ctx.subtotalSatang,
  });

  return json({
    ok: true,
    quotes: quotes.map((q) => ({
      methodId: q.methodId,
      label: q.name,
      amountSatang: q.amountSatang,
    })),
  });
};
