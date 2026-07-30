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
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { OrderService } from "$plugins/shop/order-service";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { parseBahtToSatang } from "$plugins/shop/money";
import { track, buildEventContext } from "$lib/server/analytics/track";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "admin")) throw redirect(302, "/admin");
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const svc = new OrderService(env.DB);
  const order = await svc.getOrder(params.id);
  if (!order) throw error(404, "Order not found");
  return { order };
};

export const actions: Actions = {
  fulfil: async ({ locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const svc = new OrderService(env.DB);
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
    const svc = new OrderService(env.DB);
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

    const svc = new OrderService(env.DB);
    const order = await svc.getOrder(params.id);
    if (!order) return fail(404, { error: "Order not found" });
    if (!order.providerChargeId) {
      return fail(400, {
        error: "Order has no provider charge id — cannot refund",
      });
    }

    const amount =
      kind === "refund_full" ? order.totalSatang : parseBahtToSatang(amountStr);
    if (amount === null || amount <= 0) {
      return fail(400, { error: "Enter a valid refund amount in baht" });
    }
    // Cap against remaining refundable = total - abs(sum of prior refund adjustments).
    // Prevents "click 500฿ twice on a 700฿ order" from over-refunding.
    const priorRefundedSatang = order.adjustments
      .filter((a) => a.kind === "refund_full" || a.kind === "refund_partial")
      .reduce((sum, a) => sum + Math.abs(a.amountSatang), 0);
    const refundable = order.totalSatang - priorRefundedSatang;
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

    await svc.recordRefund({
      orderId: params.id,
      amountSatang: amount,
      reason,
      createdBy: locals.user.id,
      kind,
    });
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
