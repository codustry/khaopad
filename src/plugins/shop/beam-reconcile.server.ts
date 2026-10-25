/**
 * Confirm a pending Beam order by ASKING Beam, not only waiting for its
 * webhook (#218). Two callers:
 *
 *   - the order-status endpoint, polled every few seconds while the
 *     customer watches the QR or "confirming payment" screen — only for
 *     a caller who may view the order, throttled per order;
 *   - the cron sweep, which checks recent pending orders nobody is
 *     watching (customer closed the tab, webhook never registered).
 *
 * Safety: this moves an order to PAID without a signed webhook, so it
 * trusts only what it fetched itself over our authenticated API call.
 *   - Only `succeeded` settles. `failed` is REPORTED to the page and
 *     never cancels — the customer can still pay with a new QR.
 *   - checkSettlement: amount and reference must match the order
 *     whenever Beam reports them; a mismatch refuses and logs.
 *   - Settlement goes through settleBeamPayment, the webhook's own
 *     path, whose side effects are CAS-gated: racing it is harmless.
 */
import { and, eq, gte, isNotNull, or, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { resolveProviderForRequest } from "./beam-config.server";
import {
  checkSettlement,
  settleBeamPayment,
  type SettleContext,
} from "./beam-settle.server";
import type { ChargeStatusResult } from "./payment";
import { shopOrders } from "./schema-cart";
import { canViewOrder } from "$lib/server/shop/order-access";
import type { AuthUser } from "$lib/server/auth/types";
import type { Cookies } from "@sveltejs/kit";

type ShopOrderRow = typeof shopOrders.$inferSelect;

/** What the storefront is told about the charge behind a pending order. */
export type ChargeState = "pending" | "failed";

export type ReconcileDecision =
  | { action: "settle" }
  | { action: "report"; charge: ChargeState }
  | { action: "refuse"; reason: string };

/** Per-order minimum gap between Beam lookups from the status endpoint. */
export const CHECK_INTERVAL_MS = 10_000;
const lastChecked = new Map<string, number>();

/**
 * Pure decision: what to do with what Beam said. Every rule in the
 * module docblock is enforced here, not in the I/O code.
 */
export function decideReconcile(
  order: Pick<ShopOrderRow, "status" | "totalSatang" | "orderNumber">,
  result: ChargeStatusResult,
): ReconcileDecision {
  if (order.status !== "pending" || !result.ok) {
    return { action: "report", charge: "pending" };
  }
  if (result.status === "failed") return { action: "report", charge: "failed" };
  if (result.status !== "succeeded") {
    return { action: "report", charge: "pending" };
  }
  const check = checkSettlement(order, result);
  return check.ok
    ? { action: "settle" }
    : { action: "refuse", reason: check.reason };
}

/** True when this order may be checked now; records the check if so. */
export function takeCheckSlot(orderId: string, now = Date.now()): boolean {
  const last = lastChecked.get(orderId) ?? 0;
  if (now - last < CHECK_INTERVAL_MS) return false;
  lastChecked.set(orderId, now);
  // Bound memory in a long-lived isolate: entries older than the
  // interval carry no throttling information.
  if (lastChecked.size > 500) {
    for (const [id, t] of lastChecked) {
      if (now - t > CHECK_INTERVAL_MS) lastChecked.delete(id);
    }
  }
  return true;
}

/**
 * Check one pending Beam order and settle it if paid. Returns the
 * order's status afterwards plus, while still pending, the charge state
 * for the UI. Never throws: any failure leaves the order pending.
 */
export async function reconcileBeamOrder(
  ctx: SettleContext,
  order: ShopOrderRow,
): Promise<{ status: string; charge?: ChargeState }> {
  if (order.status !== "pending") return { status: order.status };
  if ((order.providerName ?? "beam") !== "beam" || !order.providerChargeId) {
    return { status: order.status };
  }
  try {
    const provider = await resolveProviderForRequest(ctx.env, "beam");
    if (!provider?.getChargeStatus) return { status: order.status };
    const result = await provider.getChargeStatus(order.providerChargeId);
    const decision = decideReconcile(order, result);
    if (decision.action === "report") {
      return { status: order.status, charge: decision.charge };
    }
    if (decision.action === "refuse") {
      console.warn(
        `[shop.reconcile] ${order.orderNumber}: Beam reports paid but ${decision.reason} — not settling`,
      );
      return { status: order.status, charge: "pending" };
    }
    // A payment-link lookup reports the real charge id; prefer it so
    // refunds have something Beam can refund against.
    const paid = await settleBeamPayment(
      ctx,
      order,
      (result.ok && result.chargeId) || order.providerChargeId,
    );
    return { status: paid.status };
  } catch (err) {
    console.warn(
      `[shop.reconcile] ${order.orderNumber} check failed:`,
      err instanceof Error ? err.message : err,
    );
    return { status: order.status };
  }
}

/**
 * How far back the sweep looks. A payment link is payable for an hour
 * and a QR for 30 minutes; three hours covers both plus Beam's own
 * webhook retry window, without re-asking about ancient abandons.
 */
export const SWEEP_LOOKBACK_MS = 3 * 60 * 60 * 1000;
/** Upper bound per tick, so a backlog can't burst Beam's API. */
export const SWEEP_LIMIT = 25;

/** Cron: reconcile recent pending Beam orders that have a charge. */
export async function reconcilePendingBeamOrders(
  ctx: SettleContext,
  now = new Date(),
): Promise<{ checked: number; settled: number }> {
  const since = new Date(now.getTime() - SWEEP_LOOKBACK_MS).toISOString();
  const rows = await drizzle(ctx.env.DB)
    .select()
    .from(shopOrders)
    .where(
      and(
        eq(shopOrders.status, "pending"),
        isNotNull(shopOrders.providerChargeId),
        or(
          isNull(shopOrders.providerName),
          eq(shopOrders.providerName, "beam"),
        ),
        gte(shopOrders.createdAt, since),
      ),
    )
    .limit(SWEEP_LIMIT)
    .all();
  let settled = 0;
  for (const order of rows) {
    const after = await reconcileBeamOrder(ctx, order);
    if (after.status === "paid") settled++;
  }
  return { checked: rows.length, settled };
}

/**
 * The order-status endpoint's pending path. Reconciles only for a caller
 * who may VIEW the order (order-access.ts): the endpoint itself is
 * public, and without this gate anyone walking order numbers could make
 * the store call Beam for every pending order. Returns the status and
 * charge state and nothing else — the endpoint's whole disclosure budget.
 */
export async function checkPendingForViewer(
  ctx: SettleContext & {
    cookies: Cookies;
    user: AuthUser | null;
  },
  orderNumber: string,
): Promise<{ status: string; charge?: ChargeState }> {
  const order = await drizzle(ctx.env.DB)
    .select()
    .from(shopOrders)
    .where(eq(shopOrders.orderNumber, orderNumber))
    .limit(1)
    .get();
  if (!order) return { status: "pending" };
  if (order.status !== "pending") return { status: order.status };
  const allowed = await canViewOrder({
    order,
    user: ctx.user,
    email: ctx.request.headers.get("x-order-email"),
    cookies: ctx.cookies,
    secret: ctx.env.BETTER_AUTH_SECRET,
  });
  if (!allowed || !takeCheckSlot(order.id)) return { status: order.status };
  return reconcileBeamOrder(ctx, order);
}
