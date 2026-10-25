/**
 * POST /api/shop/checkout/pay — create a payment charge for a pending order.
 *
 * Body: { orderId?: string, orderNumber?: string, email?: string,
 *         method?: "promptpay" | "card", attempt?: string }
 *
 * `attempt` asks for a NEW charge on the same order — a fresh QR after
 * the last expired, a retry after a decline — rather than a replay of
 * the first one (see ChargeInput.attempt). Omit it on the first try.
 * Returns (hosted link): { ok, providerChargeId, paymentUrl, extra }
 * Returns (in-page QR):  { ok, providerChargeId, orderNumber,
 *                          qr: { image, expiresAt } }
 *
 * Two-step separation from /checkout/start lets the storefront show
 * a summary + address review before locking in the payment.
 *
 * ── Pay-by-orderNumber (#157) ───────────────────────────────────────
 * `orderNumber` is accepted as an alternative to `orderId` so the
 * order-status page can offer a "Complete payment" retry — the customer
 * who abandoned the Beam page only holds the order NUMBER (it's in
 * their URL and receipt email), never the internal id.
 *
 * ACCESS (v4.5.1): an order number is sequential, so paying BY NUMBER
 * needs the same proof as viewing the order (order-access.ts) — the
 * browser that placed it, the owning account, staff, or `email`. It
 * used to be an "accepted risk" that anyone could mint a link; the
 * real cost was that minting re-points the order's stored charge id,
 * so a stranger could disrupt a customer mid-payment. Refusals are the
 * same 404 as a missing order. `orderId` (an unguessable nanoid from
 * checkout/start) needs no further proof.
 */
import { error, json } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OrderService } from "$plugins/shop/order-service";
import { shopOrders } from "$plugins/shop/schema-cart";
import {
  diagnoseProviderConfig,
  providerConfigMessage,
  resolveProviderForMethod,
  resolveProviderForRequest,
} from "$plugins/shop/beam-config.server";
import { requireSameOrigin } from "$lib/server/http/same-origin";
import { CartService } from "$plugins/shop/cart-service";
import { canViewOrder } from "$lib/server/shop/order-access";
import { cookieName } from "$lib/paraglide/runtime";
import { DEFAULT_LOCALE, localePath, toLocale } from "$lib/i18n";
import type { RequestHandler } from "./$types";

/** How long a created charge stays payable (Beam: QR 30 min, link 60). */
const QR_HOLD_MS = 30 * 60 * 1000;
const LINK_HOLD_MS = 60 * 60 * 1000;

export const POST: RequestHandler = async ({
  request,
  platform,
  url,
  cookies,
  locals,
}) => {
  // Checkout creates orders and initiates charges — the highest-value
  // state change in the app, and it had no provenance check at all
  // while the lower-stakes cart routes did.
  const originGuard = requireSameOrigin(request, url);
  if (originGuard) return originGuard;
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
    orderNumber?: string;
    /** With `orderNumber`: proves access the way ?email= does. */
    email?: string;
    method?: string;
    attempt?: string;
  } | null;
  if (!body?.orderId && !body?.orderNumber) {
    throw error(400, "orderId or orderNumber required");
  }

  const orderSvc = new OrderService(env.DB);
  const order = body.orderId
    ? await orderSvc.getOrder(body.orderId)
    : await orderSvc.getOrderByNumber(body.orderNumber!);
  // An orderId is an unguessable nanoid handed out by checkout/start; an
  // order NUMBER is sequential, so paying by number needs the same proof
  // as viewing the order (v4.5.1) — otherwise anyone could re-point a
  // stranger's pending order at a new charge.
  if (
    !order ||
    (!body.orderId &&
      !(await canViewOrder({
        order,
        user: locals.user,
        email: body.email,
        cookies,
        secret: env.BETTER_AUTH_SECRET,
      })))
  ) {
    throw error(404, "Order not found");
  }
  if (order.status !== "pending") {
    return json(
      {
        ok: false,
        code: "ORDER_NOT_PENDING",
        message: `Order is ${order.status}, cannot charge`,
      },
      { status: 400 },
    );
  }

  // Per-METHOD provider routing (#160 E-3): the customer's chosen
  // method picks the provider — 'promptpay' → Beam, 'card' → Stripe
  // when configured (Beam hosted link otherwise, preserving the
  // pre-Stripe behaviour on unconfigured installs). Without a method
  // the order's stored provider wins — a payment retry must hit the
  // provider that may already hold a session for it.
  const provider = body.method
    ? await resolveProviderForMethod(env, body.method)
    : await resolveProviderForRequest(env, order.providerName ?? "beam");
  if (!provider) {
    // AUDIT F12: the message used to interpolate order.providerName
    // unconditionally, so a method-routed request (where the order's
    // stored name is irrelevant, and often NULL before any charge) read
    // "Payment provider 'null' is not configured" and pointed the
    // operator at Beam's env vars even when Stripe was the provider
    // actually attempted. Name what we TRIED to resolve, and list the
    // env vars for that provider.
    const attempted = body.method
      ? // resolveProviderForMethod routes 'card' → Stripe (Beam hosted
        // link as fallback) and everything else → Beam.
        body.method === "card"
        ? "stripe"
        : "beam"
      : (order.providerName ?? "beam");
    // #216: say WHICH credential is the problem — unset, saved but
    // undecryptable (a rotated BETTER_AUTH_SECRET), or set under a name
    // Khao Pad doesn't read — and point at the admin, not a redeploy.
    // Key names only, never values.
    const diagnosis = await diagnoseProviderConfig(env, attempted);
    const message = providerConfigMessage(attempted, body.method, diagnosis);
    console.error(`[shop.pay] ${order.orderNumber}: ${message}`);
    return json(
      {
        ok: false,
        code: "PAYMENT_PROVIDER_NOT_CONFIGURED",
        message,
        missing: diagnosis.missing,
        undecryptable: diagnosis.undecryptable,
      },
      { status: 503 },
    );
  }
  // Persist the routed provider on the order when it differs from the
  // stored one (checkout/start defaults to "beam"): the admin refund
  // action and any later webhook resolution dispatch on providerName —
  // refunding a Stripe charge through Beam can never work. Called only
  // AFTER a charge is successfully created: flipping the name before
  // the attempt would mislabel the order when the charge fails (and
  // the fallback provider, or a later retry, succeeds instead). The
  // settling webhook remains the FINAL authority — it re-stamps the
  // provider that actually took the money, covering the crossed-retry
  // case where an older session settles after a re-route.
  // Stock stays held for as long as the customer can pay (v4.6.0). A
  // hold is 15 min from checkout/start; Beam's QR lives 30 min and its
  // payment link 60. Best-effort: a failed extension must never block
  // the payment itself (markPaid copes with a lapsed hold).
  const holdUntil = async (ms: number) => {
    try {
      await new CartService(env.DB).extendOrderHolds(
        order.id,
        new Date(Date.now() + ms),
      );
    } catch (err) {
      console.warn(
        `[shop.pay] could not extend holds for ${order.orderNumber}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  const persistProviderName = async () => {
    if (provider.name !== (order.providerName ?? "beam")) {
      await drizzle(env.DB)
        .update(shopOrders)
        .set({
          providerName: provider.name,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(shopOrders.id, order.id));
    }
  };

  // Return URL: localized order page + ?payment=returned (#157). This
  // is an API route with no locale param, so the locale comes from the
  // Paraglide cookie (same pattern as the /cart redirect stub) — a
  // Thai customer now lands back on the THAI order page. The
  // ?payment=returned param is a UI hint that puts the page into its
  // "confirming payment" polling state; it carries no authority over
  // payment state — only the webhook writes `paid`.
  const locale = toLocale(cookies.get(cookieName) ?? DEFAULT_LOCALE);
  const returnUrl = `${url.origin}${localePath(
    locale,
    `/order/${order.orderNumber}`,
  )}?payment=returned`;

  const chargeInput = {
    orderId: order.id,
    // Beam sends this as `order.referenceId` and echoes it in every
    // webhook — the join key that lets the first payment webhook find
    // the order before a real charge id exists (#151).
    orderNumber: order.orderNumber,
    description: `${order.orderNumber} — ${order.items.length} item(s)`,
    amount: order.totalSatang,
    currency: "THB",
    customerEmail: order.email,
    returnUrl,
    metadata: { orderNumber: order.orderNumber },
    // Short opaque token only — it becomes part of an idempotency key.
    ...(typeof body.attempt === "string" &&
    /^[A-Za-z0-9-]{1,40}$/.test(body.attempt)
      ? { attempt: body.attempt }
      : {}),
  };

  // In-page PromptPay QR (#156) — duck-typed: only when the storefront
  // asked for it AND the provider implements it. ANY failure (throw,
  // ok:false, missing method) falls through to the hosted payment-link
  // path below — the customer must never be stranded because QR failed.
  if (
    body.method === "promptpay" &&
    typeof provider.createQrCharge === "function"
  ) {
    try {
      const qr = await provider.createQrCharge(chargeInput);
      if (qr.ok) {
        await persistProviderName();
        await holdUntil(QR_HOLD_MS);
        // Persisted exactly like createCharge's providerChargeId — the
        // webhook route swaps in the settled charge id via markPaid.
        await orderSvc.attachProviderCharge({
          orderId: order.id,
          providerChargeId: qr.providerChargeId,
        });
        return json({
          ok: true,
          providerChargeId: qr.providerChargeId,
          orderNumber: order.orderNumber,
          qr: { image: qr.qrImage, expiresAt: qr.qrExpiresAt },
        });
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.pay] QR charge failed for ${order.orderNumber} (${qr.code}), falling back to hosted link`,
      );
    } catch (err) {
      // Contract says createQrCharge never throws, but a duck-typed
      // third-party provider might — swallow and fall back.
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.pay] QR charge threw for ${order.orderNumber}, falling back to hosted link:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const charge = await provider.createCharge(chargeInput);

  if (!charge.ok) {
    return json(
      { ok: false, code: charge.code, message: charge.message },
      { status: 502 },
    );
  }

  await persistProviderName();
  await holdUntil(LINK_HOLD_MS);
  await orderSvc.attachProviderCharge({
    orderId: order.id,
    providerChargeId: charge.providerChargeId,
  });

  return json({
    ok: true,
    providerChargeId: charge.providerChargeId,
    paymentUrl: charge.paymentUrl,
    extra: charge.extra,
  });
};
