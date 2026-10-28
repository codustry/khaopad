/**
 * GET /api/shop/order/[orderNumber]/status — order status, ALONE (#157).
 *
 * Returns { ok: true, status } and NOTHING else — no items, no email,
 * no address, no totals. An order number is a weak secret, and this
 * endpoint is deliberately unauthenticated so the QR step and the
 * "confirming payment" pending page can poll it without holding the
 * customer's email. The status string is the entire disclosure budget.
 *
 * v4.6.0 (#218): while an order is pending, a caller who may VIEW it
 * (the browser that placed it, or one presenting its email in the
 * `x-order-email` header) also triggers a direct Beam lookup, throttled
 * per order — so a paid order settles even if the webhook never comes.
 * The response then carries `charge: "pending" | "failed"`, which says
 * nothing the payer's own banking app doesn't. Anyone else gets the
 * stored status only, and causes no outbound call.
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
import { checkPendingForViewer } from "$plugins/shop/beam-reconcile.server";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({
  params,
  platform,
  locals,
  url,
  request,
  cookies,
}) => {
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
  if (row.status !== "pending") return json({ ok: true, status: row.status });

  const { status, charge } = await checkPendingForViewer(
    {
      env,
      content: locals.content,
      url,
      request,
      cookies,
      user: locals.user,
    },
    params.orderNumber,
  );
  return json({ ok: true, status, ...(charge ? { charge } : {}) });
};
