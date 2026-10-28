/**
 * Who may see a customer order (#security, v4.5.1).
 *
 * Order numbers are sequential (KP-2026-00001, …00002), so holding one
 * proves nothing — and the order page shows the buyer's email, phone
 * and shipping address. Access needs ONE of:
 *
 *   1. Staff (admin+), who manage orders anyway.
 *   2. A signed-in customer who owns the order — by user id, or by a
 *      VERIFIED account email equal to the order's email.
 *   3. The order's email, as the receipt links (`?email=`) and the
 *      /lookup form provide — Shopify's guest-lookup model.
 *   4. This browser placed the order: checkout/start sets a signed
 *      cookie naming it, so a guest returning from the payment page
 *      lands on their own order without retyping their email. The HMAC
 *      (keyed by BETTER_AUTH_SECRET) stops anyone minting the cookie
 *      for an order number they guessed.
 *
 * Callers answer "no" with the same 404 as a missing order, so a
 * refusal never confirms that an order number exists.
 */
import type { Cookies } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import type { AuthUser } from "$lib/server/auth/types";

export const ORDER_ACCESS_COOKIE = "khaopad_order_access";
const MAX_ORDERS = 10;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

async function sign(secret: string, orderNumber: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`order-access:${orderNumber}`),
  );
  // 128 bits of the MAC is ample for a cookie-sized proof.
  return btoa(String.fromCharCode(...new Uint8Array(mac).slice(0, 16)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function readEntries(cookies: Cookies): string[] {
  return (cookies.get(ORDER_ACCESS_COOKIE) ?? "").split(",").filter(Boolean);
}

/** Remember that this browser placed `orderNumber`. */
export async function grantOrderAccess(
  cookies: Cookies,
  secret: string | undefined,
  orderNumber: string,
): Promise<void> {
  if (!secret) return;
  const entry = `${orderNumber}.${await sign(secret, orderNumber)}`;
  const kept = readEntries(cookies).filter(
    (e) => !e.startsWith(`${orderNumber}.`),
  );
  cookies.set(
    ORDER_ACCESS_COOKIE,
    [entry, ...kept].slice(0, MAX_ORDERS).join(","),
    {
      path: "/",
      httpOnly: true,
      secure: true,
      // Lax, not Strict: the payment provider's redirect back to the order
      // page is a cross-site top-level GET and must carry the cookie.
      sameSite: "lax",
      maxAge: MAX_AGE_SECONDS,
    },
  );
}

/** Did this browser place `orderNumber`? Verified, never trusted. */
export async function browserPlacedOrder(
  cookies: Cookies,
  secret: string | undefined,
  orderNumber: string,
): Promise<boolean> {
  if (!secret) return false;
  const expected = `${orderNumber}.${await sign(secret, orderNumber)}`;
  return readEntries(cookies).some((e) => e === expected);
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export async function canViewOrder(input: {
  order: { orderNumber: string; email: string; userId: string | null };
  user: AuthUser | null | undefined;
  /** An email the requester presented (`?email=`, a form field). */
  email: string | null | undefined;
  cookies: Cookies;
  secret: string | undefined;
}): Promise<boolean> {
  const { order, user, email, cookies, secret } = input;
  const orderEmail = norm(order.email);
  if (user && hasRole(user, "admin")) return true;
  if (user && order.userId && order.userId === user.id) return true;
  if (user?.emailVerified && orderEmail && norm(user.email) === orderEmail) {
    return true;
  }
  if (orderEmail && norm(email) === orderEmail) return true;
  return browserPlacedOrder(cookies, secret, order.orderNumber);
}
