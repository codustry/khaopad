/**
 * Cart session cookie — HTTP-only, SameSite=Lax, path=/, 30-day TTL.
 *
 * Stores a per-visitor `sessionId` (nanoid). CartService uses this to
 * key the open cart. The cookie is opaque — no PII, no user id — so
 * guest and signed-in flows work the same way; upgrading to a signed-
 * in cart happens in-app via CartService.ensureCart({userId}).
 *
 * NOT security-sensitive on its own: someone stealing this cookie
 * gets access to whatever's in the guest's cart, no more. The auth
 * cookie (__Host-khaopad_session) covers authenticated flows.
 */
import { dev } from "$app/environment";
import type { Cookies } from "@sveltejs/kit";
import { nanoid } from "nanoid";

const COOKIE_NAME = "khaopad_shop_cart";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Get the existing cart session id, or mint + set a new one. Always
 * returns a valid session id. Caller decides whether to touch the
 * cart (via CartService.ensureCart).
 *
 * `secure: !dev` — production requires HTTPS (Cloudflare enforces
 * this at the edge); `pnpm dev` on http://localhost:5173 needs
 * secure=false or browsers silently drop the Set-Cookie, breaking
 * every add-to-cart locally.
 */
export function ensureCartSession(cookies: Cookies): string {
  const existing = cookies.get(COOKIE_NAME);
  if (existing && existing.length >= 12) return existing;
  const sessionId = nanoid();
  cookies.set(COOKIE_NAME, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: !dev,
    maxAge: MAX_AGE_SECONDS,
  });
  return sessionId;
}

/**
 * Read the cart cookie without setting one. For public routes that
 * only render the cart if it exists (e.g. cart-count badge in the
 * header) — no reason to plant a cookie on a passer-by.
 */
export function readCartSession(cookies: Cookies): string | null {
  const existing = cookies.get(COOKIE_NAME);
  return existing && existing.length >= 12 ? existing : null;
}

/**
 * Wipe the cart cookie — called after successful checkout so the
 * next visit starts a fresh cart. The old cart row transitions to
 * `ordered` status; a new sessionId will not collide with it.
 */
export function clearCartSession(cookies: Cookies): void {
  cookies.delete(COOKIE_NAME, { path: "/" });
}
