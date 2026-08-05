/**
 * GET/POST /api/shop/cron/sweep — reservation + abandoned-cart sweep.
 *
 * Called by Cloudflare Cron Triggers every minute (schedule declared
 * in wrangler.toml `[[triggers]]` → then a fetch to this URL from the
 * scheduled handler; simpler than the adapter's `worker` slot for
 * v3.2).
 *
 * Auth: shared secret via `?token=<CRON_SECRET>` query param — Cron
 * Triggers can post an arbitrary URL, so the token is our only guard.
 * Set `CRON_SECRET` in wrangler.toml [vars] to a random 64-char string.
 *
 * Returns: { releasedReservations, abandonedCarts, ms }
 */
import { error, json } from "@sveltejs/kit";
import { CartService } from "$plugins/shop/cart-service";
import type { RequestHandler } from "./$types";

async function runSweep(env: App.Platform["env"]) {
  const startedAt = Date.now();
  const svc = new CartService(env.DB);
  const now = new Date();
  const releasedReservations = await svc.sweepExpiredReservations(now);
  const abandonedCarts = await svc.sweepAbandonedCarts(now);

  // v3.5 recovery emails. Fire-and-forget per cart — one Resend
  // request per eligible cart, mark sent so the next tick skips.
  // Capped by listCartsForRecoveryEmail (50/tick) so a cold-start
  // catch-up doesn't burst Resend.
  let recoveryEmailsSent = 0;
  try {
    const { sendAbandonedCartEmail } =
      await import("$plugins/shop/abandoned-cart-email");
    const eligible = await svc.listCartsForRecoveryEmail(now);
    for (const cart of eligible) {
      // Mark before sending. If the send fails we've burned this cart's
      // one recovery attempt, which is the cheaper failure: marking
      // after would re-send every minute to everyone whose delivery
      // ambiguously failed (Resend accepted, connection dropped).
      await svc.markRecoveryEmailSent(cart.cartId, now);
      const ok = await sendAbandonedCartEmail(env, cart);
      if (ok) recoveryEmailsSent++;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[shop.cron] recovery email pass failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // #154: record the sweep time so checkout-start's opportunistic
  // sweep (throttled on the same key) skips its next window — installs
  // WITH cron enabled shouldn't double-sweep on every checkout.
  try {
    await env.CONTENT_CACHE.put("shop:lastSweepAt", now.toISOString());
  } catch {
    /* bookkeeping only — an extra opportunistic sweep is harmless */
  }

  const ms = Date.now() - startedAt;
  return { releasedReservations, abandonedCarts, recoveryEmailsSent, ms };
}

function guard(request: Request, env: App.Platform["env"]) {
  // Prefer header (avoids logging the secret in query strings). Falls
  // back to ?token= for compatibility with Cloudflare Cron Triggers'
  // simplest URL-only form — but log a warning when that path is used.
  const header = request.headers.get("x-cron-secret") ?? "";
  const url = new URL(request.url);
  const token = header || url.searchParams.get("token") || "";
  if (header === "" && url.searchParams.get("token")) {
    // eslint-disable-next-line no-console
    console.warn(
      "[shop.cron] secret received via query string — prefer X-Cron-Secret header (query values are logged)",
    );
  }
  const expected = env.CRON_SECRET ?? "";
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export const POST: RequestHandler = async ({ request, platform }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  if (!guard(request, env)) throw error(401, "Invalid or missing token");
  const result = await runSweep(env);
  return json({ ok: true, ...result });
};

// GET for manual triggering in dev + for wrangler-emitted cron requests
// that default to GET.
export const GET: RequestHandler = async ({ request, platform }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  if (!guard(request, env)) throw error(401, "Invalid or missing token");
  const result = await runSweep(env);
  return json({ ok: true, ...result });
};
