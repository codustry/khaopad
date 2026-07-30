/**
 * POST /api/shop/checkout/start — start checkout.
 *
 * Flips the cart to `checkout_started`, reserves inventory for
 * 15 minutes. Creates the order (status='pending', no charge yet).
 * The next call — /api/shop/checkout/pay — creates the Beam charge
 * and returns the payment URL/QR to the customer.
 *
 * Body: { email: string, shippingAddress?: OrderAddress, billingAddress?: OrderAddress }
 * Returns: { orderId, orderNumber, reservations, expiresAt }
 */
import { error, json } from "@sveltejs/kit";
import { CartService, CartError } from "$plugins/shop/cart-service";
import { OrderService } from "$plugins/shop/order-service";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import { ShopValidationError } from "$plugins/shop/service";
import { track, buildEventContext } from "$lib/server/analytics/track";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({
  request,
  platform,
  cookies,
  locals,
  url,
}) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const body = (await request.json().catch(() => null)) as {
    email?: string;
    shippingAddress?: unknown;
    billingAddress?: unknown;
    /**
     * v3.4 federation: article slug the visitor came from before
     * they entered the funnel. Client reads this from
     * sessionStorage (stashed by the product page). Resolved to
     * an article id server-side and included in the analytics
     * purchase event so per-article dashboards can show
     * "products this article drove" with accurate revenue.
     */
    attributedArticleSlug?: string;
  } | null;
  const email = String(body?.email ?? "").trim();
  if (!email || !email.includes("@")) {
    return json(
      { ok: false, code: "INVALID_EMAIL", message: "Valid email required" },
      { status: 400 },
    );
  }

  const sessionId = ensureCartSession(cookies);
  const cartSvc = new CartService(env.DB);
  const cart = await cartSvc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });

  try {
    // v3.5: read the discount code that may be stashed on the cart
    // (via POST /api/shop/cart/discount). Re-validate at checkout time
    // — the code might have hit its cap or expired between apply and
    // checkout. Attribution stashes have `attribution:` prefix; only
    // plain codes get applied here.
    let discountSatang = 0;
    let discountCodeSnapshot: string | null = null;
    let discountId: string | null = null;
    if (cart.discountCode && !cart.discountCode.startsWith("attribution:")) {
      const items = await cartSvc.listCartItems(cart.id);
      const subtotal = items.reduce(
        (sum, i) => sum + i.priceSatangAtAdd * i.quantity,
        0,
      );
      const { validateDiscount } =
        await import("$plugins/shop/discount-service");
      const outcome = await validateDiscount(env.DB, {
        code: cart.discountCode,
        subtotalSatang: subtotal,
        shippingSatang: 0,
        userId: locals.user?.id ?? null,
        userEmail: email,
      });
      if (outcome.ok) {
        discountSatang = outcome.amountSatang;
        discountCodeSnapshot = outcome.discount.code;
        discountId = outcome.discount.id;
      }
      // Silent no-op on invalidation — customer proceeds without
      // discount rather than being blocked at the door. The receipt
      // won't show a discount they didn't get.
    }

    const { reservations } = await cartSvc.startCheckout({
      cartId: cart.id,
      email,
    });

    const orderSvc = new OrderService(env.DB);
    const { orderId, orderNumber } = await orderSvc.createFromCart({
      cartId: cart.id,
      email,
      providerName: "beam", // v3.2 default; #61 will let customer pick
      shippingAddress: body?.shippingAddress as Parameters<
        typeof orderSvc.createFromCart
      >[0]["shippingAddress"],
      billingAddress: body?.billingAddress as Parameters<
        typeof orderSvc.createFromCart
      >[0]["billingAddress"],
      discountSatang,
      discountCodeSnapshot,
    });

    // Stash the discount id on the cart's discountCode column too so
    // the webhook can record the redemption. Format:
    //   `<discountId>:<code>` when a discount is applied
    //   `attribution:<articleId>` for v3.4 attribution
    // The webhook parses both prefixes.
    if (discountId && discountCodeSnapshot) {
      const { drizzle } = await import("drizzle-orm/d1");
      const { eq } = await import("drizzle-orm");
      const { shopCarts } = await import("$plugins/shop/schema-cart");
      try {
        await drizzle(env.DB)
          .update(shopCarts)
          .set({ discountCode: `${discountId}:${discountCodeSnapshot}` })
          .where(eq(shopCarts.id, cart.id));
      } catch {
        /* redemption tracking can miss — better than blocking checkout */
      }
    }

    // Track begin_checkout. Uses reservations for item count/subtotal
    // since we don't want to re-hydrate the cart just for analytics.
    // v3.4: resolve attributedArticleSlug → article id and include in
    // the event properties. The webhook's `purchase` event copies it
    // forward — dashboard's article analytics reads attributedArticleId
    // from `purchase` events to power the "products this article drove"
    // panel.
    let attributedArticleId: string | undefined;
    if (
      body?.attributedArticleSlug &&
      // Cap length at 128 chars — slugify's practical max is ~80,
      // this leaves headroom without inviting a DOS via a 100KB
      // payload dropped into getArticleBySlug.
      body.attributedArticleSlug.length <= 128 &&
      /^[a-z0-9-]+$/.test(body.attributedArticleSlug)
    ) {
      try {
        const article = await locals.content.getArticleBySlug(
          body.attributedArticleSlug,
        );
        if (article) attributedArticleId = article.id;
      } catch {
        /* content provider unavailable — attribution stays undefined */
      }
    }
    void track(
      env.DB,
      "begin_checkout",
      {
        cartId: cart.id,
        itemCount: reservations.reduce((s, r) => s + r.quantity, 0),
        subtotalSatang: 0, // exact subtotal is on the order; dashboard joins if needed
      },
      buildEventContext({
        url,
        request,
        sessionId,
        userId: locals.user?.id ?? null,
      }),
    );
    if (attributedArticleId) {
      // Persist attribution in the cart's discountCode column
      // (unused for v3.4; discount codes ship in v3.5 with a
      // dedicated table). Overloads the column temporarily so the
      // webhook can read `attribution:<articleId>` back at markPaid.
      //
      // Guarded: only writes when the column is NULL or already
      // carries an attribution — never overwrites a real coupon
      // code. When v3.5 discount codes land, they'll write with a
      // different prefix (or migrate off this column entirely) so
      // this coexists cleanly.
      const { drizzle } = await import("drizzle-orm/d1");
      const { eq, and, or, sql, isNull } = await import("drizzle-orm");
      const { shopCarts } = await import("$plugins/shop/schema-cart");
      try {
        await drizzle(env.DB)
          .update(shopCarts)
          .set({ discountCode: `attribution:${attributedArticleId}` })
          .where(
            and(
              eq(shopCarts.id, cart.id),
              or(
                isNull(shopCarts.discountCode),
                sql`${shopCarts.discountCode} LIKE 'attribution:%'`,
              ),
            ),
          );
      } catch {
        /* best-effort — attribution loss is acceptable */
      }
    }

    return json({
      ok: true,
      orderId,
      orderNumber,
      reservations,
    });
  } catch (err) {
    if (err instanceof CartError) {
      return json(
        {
          ok: false,
          code: err.reason,
          message: err.message,
          cartItemId: err.cartItemId,
        },
        { status: 400 },
      );
    }
    if (err instanceof ShopValidationError) {
      return json(
        { ok: false, code: err.code, message: err.message, field: err.field },
        { status: 400 },
      );
    }
    throw err;
  }
};
