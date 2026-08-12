/**
 * POST /api/sync/tonbab — inbound Tonbab POS push (#160 Phase E-1).
 *
 * Auth is the BEAM MODEL, not API-key auth: Tonbab signs the RAW body
 * with HMAC-SHA256 using the pairing-minted TONBAB_WEBHOOK_SECRET and
 * sends the base64 digest in `X-Tonbab-Signature`. We verify in
 * constant time before touching the payload.
 *
 * Responses:
 *   503 — no platform / TONBAB_WEBHOOK_SECRET unconfigured (pairing
 *         incomplete; retrying without operator action cannot help,
 *         but 503 signals "temporarily not ready" honestly)
 *   401 — missing or invalid signature
 *   400 — signed but unparseable/malformed envelope
 *   413 — batch exceeds MAX_ORDERS_PER_BATCH / MAX_ITEMS_PER_ORDER
 *         (`BATCH_TOO_LARGE`; split and resend)
 *   200 — batch processed; per-order results in the body (individual
 *         order failures are results entries, never a batch failure —
 *         Tonbab retries only the failed items)
 *
 * Echo-loop guard: POS-originated creations never emit order.created
 * (createExternalOrder skips it); transitions DO emit through the
 * normal dispatcher with `channel` in every payload so Tonbab can
 * self-filter its own orders. See docs/tonbab-sync.md.
 */
import { json } from "@sveltejs/kit";
import { getSecret } from "$lib/server/secrets/service";
import {
  parseTonbabSyncBody,
  processTonbabSync,
  verifyTonbabSignature,
} from "$lib/server/sync/tonbab";
import { OrderService } from "$plugins/shop/order-service";
import { dispatchEvent } from "$lib/server/webhooks";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform, locals }) => {
  const env = platform?.env;
  if (!env?.DB) {
    return json({ ok: false, code: "NO_PLATFORM" }, { status: 503 });
  }

  const secret = await getSecret(env, "TONBAB_WEBHOOK_SECRET");
  if (!secret) {
    return json({ ok: false, code: "SYNC_NOT_CONFIGURED" }, { status: 503 });
  }

  const signature = request.headers.get("x-tonbab-signature");
  const rawBody = await request.text();
  const verified = await verifyTonbabSignature(secret, rawBody, signature);
  if (!verified.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[sync.tonbab] verify failed: ${verified.code}`);
    return json({ ok: false, code: verified.code }, { status: 401 });
  }

  const parsed = parseTonbabSyncBody(rawBody);
  if (!parsed.ok) {
    // 413 for size, 400 for shape. The batch is rejected WHOLE — a
    // batch big enough to exhaust the Workers CPU/subrequest budget
    // would otherwise die mid-loop and leave a committed prefix,
    // which an at-least-once sender cannot reason about.
    return json(
      { ok: false, code: parsed.code, message: parsed.message },
      { status: parsed.code === "BATCH_TOO_LARGE" ? 413 : 400 },
    );
  }

  // Transitions emit domain events through the core dispatcher —
  // fire-and-forget, same wiring as the Beam webhook. Every payload
  // carries `channel`, which is Tonbab's self-filter key.
  const orderSvc = new OrderService(env.DB, {
    emitEvent: (event, payload) =>
      void dispatchEvent(locals.content, { event, payload }),
  });

  const results = await processTonbabSync(env.DB, orderSvc, parsed.body);
  return json({ ok: true, results });
};
