/**
 * /admin/shop/orders/[id] — admin order detail + lifecycle actions.
 *
 * Actions:
 *   - fulfil (paid → fulfilled; C1: carrier + tracking + shipped email)
 *   - deliver (fulfilled → delivered)
 *   - refundPartial (any amount, records adjustment + provider refund)
 *   - refundFull (records + provider refund + status='refunded')
 *   - addNote (C2: free-text timeline note)
 *   - returnTransition (C10: approve / reject / mark-received; the
 *     refund step rides the EXISTING refund action, which auto-flips a
 *     received return to refunded on success)
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { nanoid } from "nanoid";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { OrderService } from "$plugins/shop/order-service";
import { ShopValidationError } from "$plugins/shop/service";
import { resolveProviderForRequest } from "$plugins/shop/beam-config.server";
import { parseBahtToSatang } from "$plugins/shop/money";
import { CARRIERS } from "$plugins/shop/carriers";
import { sendShippedEmail } from "$plugins/shop/email";
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
  const [events, returns, fulfillment] = await Promise.all([
    svc.listOrderEvents(params.id),
    svc.listReturns(params.id),
    svc.latestFulfillment(params.id),
  ]);
  // Refund idempotency key (#110): minted per page render, echoed back
  // by the refund form. A double-click / double-submit replays the
  // same key → the service returns the original ledger row instead of
  // refunding twice.
  return {
    order,
    events,
    returns,
    fulfillment,
    refundIdempotencyKey: nanoid(),
  };
};

export const actions: Actions = {
  fulfil: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    // C1: carrier preset + tracking number. Both optional — a merchant
    // hand-delivering an order can still mark it fulfilled.
    const carrierRaw = String(fd.get("carrier") ?? "").trim();
    const carrier = CARRIERS.some((c) => c.id === carrierRaw)
      ? carrierRaw
      : null;
    const trackingNumber =
      String(fd.get("trackingNumber") ?? "").trim() || null;

    const svc = orderServiceWithEvents(env.DB, locals.content);
    const fulfillment = await svc.markFulfilled(params.id, {
      carrier,
      trackingNumber,
      actorEmail: locals.user.email,
    });
    if (!fulfillment) {
      return fail(400, {
        error: "Order is not in a fulfillable state (must be paid).",
      });
    }
    await logAudit(env.DB, locals.user.id, "order.fulfilled", params.id, {
      carrier,
      trackingNumber,
    });
    // C1: shipped email with carrier + tracking link. Best-effort — a
    // Resend hiccup must not un-fulfil the order. notifiedAt records
    // the send so a later resubmit can tell it already went out.
    const order = await svc.getOrder(params.id);
    if (order) {
      const sent = await sendShippedEmail(env, order, fulfillment);
      if (sent) await svc.markFulfillmentNotified(fulfillment.id);
    }
    return { success: true, message: "Marked fulfilled" };
  },

  deliver: async ({ locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const svc = orderServiceWithEvents(env.DB, locals.content);
    await svc.markDelivered(params.id, { actorEmail: locals.user.email });
    await logAudit(env.DB, locals.user.id, "order.delivered", params.id, {});
    return { success: true, message: "Marked delivered" };
  },

  /** C2: append a free-text staff note to the order timeline. */
  addNote: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const message = String(fd.get("message") ?? "").trim();
    if (!message) return fail(400, { error: "Note cannot be empty" });
    const svc = new OrderService(env.DB);
    try {
      await svc.addOrderNote({
        orderId: params.id,
        message,
        actorEmail: locals.user.email,
      });
    } catch (err) {
      if (err instanceof ShopValidationError) {
        return fail(400, { error: err.message });
      }
      throw err;
    }
    return { success: true, message: "Note added" };
  },

  /**
   * C10: return state transitions the admin drives directly —
   * approve / reject / mark received. The refund step is NOT here: it
   * rides the existing ?/refund action (real money must go through the
   * provider + ledger), which flips a received return to refunded on
   * success.
   */
  returnTransition: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const returnId = String(fd.get("returnId") ?? "").trim();
    const to = String(fd.get("to") ?? "").trim();
    if (!returnId || !["approved", "rejected", "received"].includes(to)) {
      return fail(400, { error: "Invalid return transition" });
    }
    const svc = new OrderService(env.DB);
    try {
      await svc.transitionReturn({
        returnId,
        to: to as "approved" | "rejected" | "received",
        actorEmail: locals.user.email,
      });
    } catch (err) {
      if (err instanceof ShopValidationError) {
        return fail(400, { error: err.message });
      }
      throw err;
    }
    await logAudit(env.DB, locals.user.id, `return.${to}`, params.id, {
      returnId,
    });
    return { success: true, message: `Return ${to}` };
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
        actorEmail: locals.user.email,
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
    // C10 hook: a refund issued while a return sits in 'received' IS
    // the return's refund step — flip the return (and the return_status
    // axis) instead of asking the admin to click a second button.
    try {
      const receivedReturn = (await svc.listReturns(params.id)).find(
        (r) => r.state === "received",
      );
      if (receivedReturn) {
        await svc.transitionReturn({
          returnId: receivedReturn.id,
          to: "refunded",
          actorEmail: locals.user.email,
        });
      }
    } catch (err) {
      // The refund itself succeeded — never surface a return-state
      // bookkeeping failure as a refund failure.
      // eslint-disable-next-line no-console
      console.error(
        `[admin.order] return refund-hook failed for ${params.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
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
