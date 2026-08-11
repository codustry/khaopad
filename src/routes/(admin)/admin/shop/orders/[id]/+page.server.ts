/**
 * /admin/shop/orders/[id] — admin order detail + lifecycle actions.
 *
 * Actions:
 *   - fulfil (paid → fulfilled)
 *   - deliver (fulfilled → delivered)
 *   - refundPartial (any amount, records adjustment + provider refund)
 *   - refundFull (records + provider refund + status='refunded')
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { nanoid } from "nanoid";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { OrderService } from "$plugins/shop/order-service";
import { ShopValidationError } from "$plugins/shop/service";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { parseBahtToSatang } from "$plugins/shop/money";
import { track, buildEventContext } from "$lib/server/analytics/track";
import { dispatchEvent } from "$lib/server/webhooks";
import type { ContentProvider } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

/** OrderService wired to emit domain events (#113) via core webhooks. */
function orderServiceWithEvents(db: D1Database, content: ContentProvider) {
  return new OrderService(db, {
    emitEvent: (event, payload) =>
      void dispatchEvent(content, { event, payload }),
  });
}

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "admin")) {
    throw error(403, "Only admins and super admins can access this area.");
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const svc = new OrderService(env.DB);
  const order = await svc.getOrder(params.id);
  if (!order) throw error(404, "Order not found");
  // Refund idempotency key (#110): minted per page render, echoed back
  // by the refund form. A double-click / double-submit replays the
  // same key → the service returns the original ledger row instead of
  // refunding twice.
  return { order, refundIdempotencyKey: nanoid() };
};

export const actions: Actions = {
  fulfil: async ({ locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const svc = orderServiceWithEvents(env.DB, locals.content);
    await svc.markFulfilled(params.id);
    await logAudit(env.DB, locals.user.id, "order.fulfilled", params.id, {});
    return { success: true, message: "Marked fulfilled" };
  },

  deliver: async ({ locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const svc = orderServiceWithEvents(env.DB, locals.content);
    await svc.markDelivered(params.id);
    await logAudit(env.DB, locals.user.id, "order.delivered", params.id, {});
    return { success: true, message: "Marked delivered" };
  },

  refund: async ({ request, locals, platform, params, url }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const amountStr = String(fd.get("amount") ?? "").trim();
    const kind = String(fd.get("kind") ?? "refund_partial") as
      | "refund_full"
      | "refund_partial";
    const reason = String(fd.get("reason") ?? "").trim() || undefined;
    // #110: form-supplied idempotency key (minted in `load`). A resent
    // form replays the same key → single ledger row.
    const idempotencyKey =
      String(fd.get("idempotencyKey") ?? "").trim() || nanoid();

    const svc = orderServiceWithEvents(env.DB, locals.content);
    const order = await svc.getOrder(params.id);
    if (!order) return fail(404, { error: "Order not found" });
    if (!order.providerChargeId) {
      return fail(400, {
        error: "Order has no provider charge id — cannot refund",
      });
    }

    // Remaining refundable derives from the adjustments LEDGER in the
    // service (#110) — the guard is domain-owned now; this pre-check
    // exists only to fail fast before calling the provider.
    const refundable = await svc.refundableSatang(params.id);
    const priorRefundedSatang = order.totalSatang - refundable;
    const amount =
      kind === "refund_full" ? refundable : parseBahtToSatang(amountStr);
    if (amount === null || amount <= 0) {
      return fail(400, { error: "Enter a valid refund amount in baht" });
    }
    if (refundable <= 0) {
      return fail(400, {
        error: `Order already fully refunded (${priorRefundedSatang / 100}฿ of ${order.totalSatang / 100}฿)`,
      });
    }
    if (amount > refundable) {
      return fail(400, {
        error: `Refund amount exceeds remaining refundable (${refundable / 100}฿; ${priorRefundedSatang / 100}฿ already refunded of ${order.totalSatang / 100}฿ total)`,
      });
    }

    // Provider refund first — if it fails, don't record the adjustment.
    const provider = await resolveProviderForRequest(
      env,
      order.providerName ?? "beam",
    );
    if (!provider) {
      return fail(503, {
        error: `Payment provider '${order.providerName}' is not configured — cannot process refund`,
      });
    }
    const refundResult = await provider.refund({
      providerChargeId: order.providerChargeId,
      amount,
      currency: "THB",
      reason,
    });
    if (!refundResult.ok) {
      return fail(502, {
        error: `Provider refund failed: ${refundResult.message}`,
      });
    }

    try {
      await svc.recordRefund({
        orderId: params.id,
        amountSatang: amount,
        reason,
        createdBy: locals.user.id,
        kind,
        idempotencyKey,
        providerRefundId: refundResult.providerRefundId,
      });
    } catch (err) {
      // Domain guard (ledger cap / idempotency-key fingerprint
      // mismatch) — surface as a form error, not a 500.
      if (err instanceof ShopValidationError) {
        return fail(400, { error: err.message });
      }
      throw err;
    }
    await logAudit(env.DB, locals.user.id, "order.refunded", params.id, {
      amount,
      kind,
      providerRefundId: refundResult.providerRefundId,
    });
    // Fire refund analytics event. Admin action, so context uses the
    // admin's session id (event dashboards will filter by name only).
    void track(
      env.DB,
      "refund",
      {
        orderId: params.id,
        amountSatang: amount,
        kind: kind === "refund_full" ? "full" : "partial",
      },
      buildEventContext({
        url,
        request,
        sessionId: locals.user.id,
        userId: locals.user.id,
      }),
    );
    return {
      success: true,
      message: `Refund of ${amount / 100}฿ processed (${refundResult.providerRefundId})`,
    };
  },
};
