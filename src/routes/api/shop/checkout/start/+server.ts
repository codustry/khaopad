/**
 * POST /api/shop/checkout/start — start checkout.
 *
 * Flips the cart to `checkout_started`, reserves inventory for
 * 15 minutes. Creates the order (status='pending', no charge yet).
 * The next call — /api/shop/checkout/pay — creates the Beam charge
 * and returns the payment URL/QR to the customer.
 *
 * Body: {
 *   email: string,
 *   shippingAddress?: OrderAddress,
 *   billingAddress?: OrderAddress,
 *   // #158: id of a shipping method quoted by the server (see
 *   // GET /api/shop/shipping/quotes). The client NEVER supplies a
 *   // price — only the method id; the amount is re-derived server-
 *   // side from the configured zones. Required when zones are
 *   // configured and a shipping address is supplied; omitted for
 *   // digital-goods carts and unconfigured stores.
 *   shippingMethod?: string,
 * }
 * Returns: { orderId, orderNumber, reservations, expiresAt }
 */
import { error, json } from "@sveltejs/kit";
import {
  CartService,
  CartError,
  RESERVATION_TTL_MS,
} from "$plugins/shop/cart-service";
import { OrderService } from "$plugins/shop/order-service";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import { ShopValidationError } from "$plugins/shop/service";
import { quoteShipping } from "$plugins/shop/shipping";
import { validateOrderAddress } from "$lib/shop/address-validation";
import type { OrderAddress } from "$plugins/shop/order-service";
import { track, buildEventContext } from "$lib/server/analytics/track";
import { requireSameOrigin } from "$lib/server/http/same-origin";
import type { RequestHandler } from "./$types";

/** KV key recording when the reservation sweep last ran. */
const LAST_SWEEP_KEY = "shop:lastSweepAt";

/**
 * #154 option (b): opportunistic sweep. Default installs ship with the
 * cron trigger commented out, so without this the expired-reservation
 * self-heal never runs at all. Piggyback on checkout-start (the moment
 * a stale `checkout_started` cart actually matters) and run the sweep
 * when the last run is older than the reservation TTL. Throttled via
 * KV so a burst of checkouts doesn't sweep on every request. Failures
 * must never fail checkout — log and move on.
 */
async function opportunisticSweep(
  env: App.Platform["env"],
  cartSvc: CartService,
) {
  try {
    const last = await env.CONTENT_CACHE.get(LAST_SWEEP_KEY);
    const lastMs = last ? Date.parse(last) : Number.NaN;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < RESERVATION_TTL_MS) {
      return;
    }
    // Mark BEFORE sweeping — concurrent checkouts should not all run
    // the sweep; losing one tick to a failed sweep is the cheap error.
    await env.CONTENT_CACHE.put(LAST_SWEEP_KEY, new Date().toISOString());
    await cartSvc.sweepExpiredReservations();
    await cartSvc.sweepAbandonedCarts();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[shop.checkout] opportunistic sweep failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export const POST: RequestHandler = async ({
  request,
  platform,
  cookies,
  locals,
  url,
}) => {
  // Checkout creates orders and initiates charges — the highest-value
  // state change in the app, and it had no provenance check at all
  // while the lower-stakes cart routes did.
  const originGuard = requireSameOrigin(request, url);
  if (originGuard) return originGuard;
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const body = (await request.json().catch(() => null)) as {
    email?: string;
    shippingAddress?: unknown;
    billingAddress?: unknown;
    shippingMethod?: unknown;
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

  try {
    const sessionId = ensureCartSession(cookies);
    const cartSvc = new CartService(env.DB);
    await opportunisticSweep(env, cartSvc);
    const cart = await cartSvc.ensureCart({
      sessionId,
      userId: locals.user?.id,
    });

    // #155: validate address blobs BEFORE any state changes. Absent
    // addresses stay allowed (digital goods); present-but-invalid is
    // a 400 naming the first failing field. Seam note: when a shop
    // plugin config surface exists, read an AddressValidator override
    // from it here instead of hardcoding the default.
    let shippingAddress: OrderAddress | null = null;
    let billingAddress: OrderAddress | null = null;
    if (body?.shippingAddress != null) {
      const result = validateOrderAddress(body.shippingAddress);
      if (!result.ok) {
        return json(
          {
            ok: false,
            code: "INVALID_ADDRESS",
            message: `shippingAddress: ${result.message}`,
          },
          { status: 400 },
        );
      }
      shippingAddress = result.address;
    }
    if (body?.billingAddress != null) {
      const result = validateOrderAddress(body.billingAddress);
      if (!result.ok) {
        return json(
          {
            ok: false,
            code: "INVALID_ADDRESS",
            message: `billingAddress: ${result.message}`,
          },
          { status: 400 },
        );
      }
      billingAddress = result.address;
    }

    // #158: price shipping server-side. The client sends only a method
    // id; the amount comes from quoteShipping() against the cart's own
    // subtotal/weight — never from the request. No address → quote
    // against the fallback ("*") zone, matching the engine's zone
    // semantics.
    const shippingContext = await cartSvc.getCartShippingContext(cart.id);
    const requestedMethod =
      typeof body?.shippingMethod === "string" && body.shippingMethod !== ""
        ? body.shippingMethod
        : null;
    const quotes = await quoteShipping(env.DB, {
      countryCode: shippingAddress?.countryCode ?? "",
      totalWeightGrams: shippingContext.totalWeightGrams,
      subtotalSatang: shippingContext.subtotalSatang,
    });
    let shippingSatang = 0;
    if (requestedMethod) {
      const chosen = quotes.find((q) => q.methodId === requestedMethod);
      if (!chosen) {
        // Validation failure, NOT a fallback to zero — silently
        // shipping for free on a bogus id would be a money bug.
        return json(
          {
            ok: false,
            code: "INVALID_SHIPPING_METHOD",
            message: "The selected shipping method is not available",
          },
          { status: 400 },
        );
      }
      shippingSatang = chosen.amountSatang;
    } else if (quotes.length > 0 && shippingAddress) {
      // Zones are configured and the customer gave a shipping address
      // — a method choice is mandatory. When quotes are empty the
      // store simply hasn't configured shipping; it still sells at 0.
      // No address + no method is the digital-goods path, also 0.
      return json(
        {
          ok: false,
          code: "SHIPPING_METHOD_REQUIRED",
          message: "Select a shipping method to continue",
        },
        { status: 400 },
      );
    }

    // v3.5: read the discount code that may be stashed on the cart
    // (via POST /api/shop/cart/discount). Re-validate at checkout time
    // — the code might have hit its cap or expired between apply and
    // checkout. Attribution stashes have `attribution:` prefix; only
    // plain codes get applied here.
    let discountSatang = 0;
    let discountCodeSnapshot: string | null = null;
    let discountId: string | null = null;
    if (cart.discountCode && !cart.discountCode.startsWith("attribution:")) {
      const { validateDiscount } =
        await import("$plugins/shop/discount-service");
      const outcome = await validateDiscount(env.DB, {
        code: cart.discountCode,
        subtotalSatang: shippingContext.subtotalSatang,
        shippingSatang,
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
      shippingAddress,
      billingAddress,
      shippingSatang,
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
    // #154: never surface SvelteKit's bare {"message":"Internal Error"}
    // for checkout — log the real cause (visible in `wrangler tail`)
    // and return a structured, non-leaking failure the storefront can
    // render.
    // eslint-disable-next-line no-console
    console.error(
      "[shop.checkout] start failed unexpectedly:",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    return json(
      {
        ok: false,
        code: "UNEXPECTED_ERROR",
        message:
          "Checkout failed unexpectedly — try again; if it persists, contact the store.",
      },
      { status: 500 },
    );
  }
};
