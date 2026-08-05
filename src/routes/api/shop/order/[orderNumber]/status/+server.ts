/**
 * GET /api/shop/order/[orderNumber]/status — order status, ALONE (#157).
 *
 * Returns { ok: true, status } and NOTHING else — no items, no email,
 * no address, no totals. An order number is a weak secret, and this
 * endpoint is deliberately unauthenticated so the QR step and the
 * "confirming payment" pending page can poll it without holding the
 * customer's email. The status string is the entire disclosure budget.
 *
 * 404 → { ok: false } with no existence details beyond the 404 itself.
 *
 * Caching: no header set here on purpose — hooks.server.ts's cacheHook
 * already short-circuits every /api/* path (that doesn't set its own
 * value) to `Cache-Control: no-store`, which covers this route. Do not
 * duplicate the header; the structural test documents this reliance.
 */
import { json } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { shopOrders } from "$plugins/shop/schema-cart";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, platform }) => {
  const env = platform?.env;
  if (!env) return json({ ok: false }, { status: 503 });

  // Minimal column select — the handler never even reads the private
  // fields, so no refactor can accidentally start returning them.
  const row = await drizzle(env.DB)
    .select({ status: shopOrders.status })
    .from(shopOrders)
    .where(eq(shopOrders.orderNumber, params.orderNumber))
    .limit(1)
    .get();

  if (!row) return json({ ok: false }, { status: 404 });
  return json({ ok: true, status: row.status });
};
