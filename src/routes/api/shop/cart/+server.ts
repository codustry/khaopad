/**
 * Cart API — public endpoints for cart manipulation.
 *
 * GET  /api/shop/cart          → current cart contents (JSON)
 * POST /api/shop/cart/items    → add item
 * PATCH /api/shop/cart/items   → update quantity
 * DELETE /api/shop/cart/items  → remove item
 *
 * All endpoints are guest-accessible (cart is session-cookie-scoped).
 * Signed-in users share the same endpoints; the cart-service upgrades
 * the cart to the user id automatically.
 */
import { error, json } from "@sveltejs/kit";
import { CartService, CartError } from "$plugins/shop/cart-service";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import { ShopValidationError } from "$plugins/shop/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, cookies, locals }) => {
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
  return json({
    cart: {
      id: cart.id,
      status: cart.status,
      email: cart.email,
      updatedAt: cart.updatedAt,
    },
    items,
    subtotalSatang: subtotal,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
  });
};

export const POST: RequestHandler = async ({ request, platform, cookies, locals }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const body = (await request.json().catch(() => null)) as
    | { variantId?: string; quantity?: number }
    | null;
  if (!body?.variantId || typeof body.variantId !== "string") {
    throw error(400, "variantId required");
  }
  const quantity = body.quantity ?? 1;

  const sessionId = ensureCartSession(cookies);
  const svc = new CartService(env.DB);
  const cart = await svc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });

  try {
    const item = await svc.addItem({
      cartId: cart.id,
      variantId: body.variantId,
      quantity,
    });
    return json({ ok: true, item });
  } catch (err) {
    if (err instanceof CartError) {
      return json(
        { ok: false, code: err.reason, message: err.message },
        { status: 400 },
      );
    }
    if (err instanceof ShopValidationError) {
      return json(
        { ok: false, code: err.code, message: err.message },
        { status: 400 },
      );
    }
    throw err;
  }
};

export const PATCH: RequestHandler = async ({ request, platform, cookies, locals }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const body = (await request.json().catch(() => null)) as
    | { cartItemId?: string; quantity?: number }
    | null;
  if (!body?.cartItemId || typeof body.quantity !== "number") {
    throw error(400, "cartItemId + quantity required");
  }
  const sessionId = ensureCartSession(cookies);
  const svc = new CartService(env.DB);
  const cart = await svc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });
  try {
    const item = await svc.setQuantity({
      cartId: cart.id,
      cartItemId: body.cartItemId,
      quantity: body.quantity,
    });
    return json({ ok: true, item });
  } catch (err) {
    if (err instanceof CartError || err instanceof ShopValidationError) {
      return json(
        { ok: false, code: (err as CartError).reason ?? (err as ShopValidationError).code, message: err.message },
        { status: 400 },
      );
    }
    throw err;
  }
};

export const DELETE: RequestHandler = async ({ request, platform, cookies, locals }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const body = (await request.json().catch(() => null)) as
    | { cartItemId?: string }
    | null;
  if (!body?.cartItemId) throw error(400, "cartItemId required");
  const sessionId = ensureCartSession(cookies);
  const svc = new CartService(env.DB);
  const cart = await svc.ensureCart({
    sessionId,
    userId: locals.user?.id,
  });
  await svc.removeItem({
    cartId: cart.id,
    cartItemId: body.cartItemId,
  });
  return json({ ok: true });
};
