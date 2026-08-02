/**
 * POST /api/shop/cart/discount — apply a discount code to the current cart.
 *
 * Body: { code: string, email?: string }
 * Returns: { ok: true, amountSatang, freeShipping } on success,
 *          { ok: false, code, message } on validation failure.
 *
 * Stashes the code in cart.discountCode (no prefix — v3.4's
 * `attribution:` prefix already handled by the write guard, so a
 * plain code coexists cleanly with an attribution stash — one
 * overwrites the other; last-write-wins, matching UX expectation).
 *
 * Server-side validation only. Client button state is UX polish, not
 * a security boundary.
 */
import { json } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { CartService } from "$plugins/shop/cart-service";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import { validateDiscount } from "$plugins/shop/discount-service";
import { shopCarts } from "$plugins/shop/schema-cart";
import { requireSameOrigin } from "$lib/server/http/same-origin";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({
  request,
  platform,
  cookies,
  locals,
  url,
}) => {
  const originGuard = requireSameOrigin(request, url);
  if (originGuard) return originGuard;

  const env = platform?.env;
  if (!env) {
    return json({ ok: false, code: "PLATFORM_NOT_READY" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as {
    code?: string;
    email?: string;
  } | null;
  const code = String(body?.code ?? "").trim();
  const email = String(body?.email ?? "").trim() || null;

  if (!code) {
    return json({ ok: false, code: "MISSING_CODE" }, { status: 400 });
  }
  if (code.length > 64) {
    return json({ ok: false, code: "CODE_TOO_LONG" }, { status: 400 });
  }

  const sessionId = ensureCartSession(cookies);
  const cartSvc = new CartService(env.DB);
  const cart = await cartSvc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });
  const items = await cartSvc.listCartItems(cart.id);
  const subtotal = items.reduce(
    (sum, i) => sum + i.priceSatangAtAdd * i.quantity,
    0,
  );

  const outcome = await validateDiscount(env.DB, {
    code,
    subtotalSatang: subtotal,
    shippingSatang: 0, // shipping calc lands with real address form; v3.5 uses 0
    userId: locals.user?.id ?? null,
    userEmail: email ?? locals.user?.email ?? null,
  });

  if (!outcome.ok) {
    return json(
      { ok: false, code: outcome.reason, message: outcome.message },
      { status: 400 },
    );
  }

  // Stash the canonical code (uppercase, no prefix) on the cart.
  //
  // This wins over a v3.4 `attribution:<articleId>` stash if one is
  // somehow present. In the normal funnel it never is — attribution is
  // written at checkout-start, strictly after this cart-page endpoint,
  // and that write is itself guarded to skip carts already carrying a
  // real coupon. The pair only collides for a customer who returns to
  // the cart after abandoning checkout, where losing the attribution
  // row is the accepted trade against silently dropping their coupon.
  await drizzle(env.DB)
    .update(shopCarts)
    .set({ discountCode: outcome.discount.code })
    .where(eq(shopCarts.id, cart.id));

  return json({
    ok: true,
    code: outcome.discount.code,
    amountSatang: outcome.amountSatang,
    freeShipping: outcome.freeShipping,
    kind: outcome.discount.kind,
  });
};

/** DELETE /api/shop/cart/discount — remove any applied discount. */
export const DELETE: RequestHandler = async ({
  request,
  platform,
  cookies,
  locals,
  url,
}) => {
  const originGuard = requireSameOrigin(request, url);
  if (originGuard) return originGuard;

  const env = platform?.env;
  if (!env) {
    return json({ ok: false, code: "PLATFORM_NOT_READY" }, { status: 503 });
  }
  const sessionId = ensureCartSession(cookies);
  const cartSvc = new CartService(env.DB);
  const cart = await cartSvc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });
  // Only clear real codes — preserve v3.4 attribution stashes so
  // per-article purchase attribution survives a customer changing
  // their mind on a discount code.
  await drizzle(env.DB)
    .update(shopCarts)
    .set({ discountCode: null })
    .where(
      and(
        eq(shopCarts.id, cart.id),
        sql`${shopCarts.discountCode} NOT LIKE 'attribution:%'`,
      ),
    );
  return json({ ok: true });
};
