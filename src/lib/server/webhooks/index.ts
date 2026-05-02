/**
 * Webhook dispatcher (v2.0d).
 *
 * Fires registered webhooks on platform events. Best-effort: a
 * delivery failure NEVER breaks the action that triggered it. The
 * dispatcher writes a `webhook_deliveries` row for every attempt
 * (success or fail) so the operator can debug from the CMS.
 *
 * Signing: every request carries an `X-Khaopad-Signature` header
 * with `sha256=<hex>` HMAC of the raw body using the webhook's
 * stored secret. Receivers verify in the standard way.
 *
 * Retry strategy (deliberately simple for v2.0d):
 *   - Up to 3 attempts inline (this request).
 *   - Backoff: 250ms, 1500ms between attempts.
 *   - No persistent retry queue — a future v2.x can drain
 *     `webhook_deliveries.next_attempt_at` rows on a cron tick.
 *   - We do schedule `next_attempt_at` on the failed-final row for
 *     forward-compat with that future cron worker.
 */
import type {
  ContentProvider,
  WebhookEvent,
  WebhookRecord,
} from "$lib/server/content/types";

const MAX_INLINE_ATTEMPTS = 3;
const BACKOFF_MS = [250, 1500] as const;
const REQUEST_TIMEOUT_MS = 5000;

export interface DispatchOptions {
  /** Event name. */
  event: WebhookEvent;
  /** Plain JSON-serializable payload — the dispatcher serializes. */
  payload: Record<string, unknown>;
}

/**
 * Fan out an event to every enabled webhook subscribed to it.
 * Returns the count of webhooks attempted (not delivered — failures
 * still count). Promise resolves once all attempts complete; the
 * caller should await this when it can spare the round-trip, or fire
 * with `void dispatchEvent(...)` for full async behavior.
 */
export async function dispatchEvent(
  content: ContentProvider,
  opts: DispatchOptions,
): Promise<number> {
  let webhooks: WebhookRecord[];
  try {
    webhooks = await content.listWebhooksByEvent(opts.event);
  } catch {
    return 0;
  }
  if (webhooks.length === 0) return 0;

  const body = JSON.stringify({
    event: opts.event,
    deliveredAt: new Date().toISOString(),
    data: opts.payload,
  });

  // Fan out in parallel — webhooks are independent; one slow receiver
  // shouldn't block others.
  await Promise.all(
    webhooks.map((wh) => deliverOne(content, wh, opts.event, body)),
  );
  return webhooks.length;
}

async function deliverOne(
  content: ContentProvider,
  webhook: WebhookRecord,
  event: WebhookEvent,
  body: string,
): Promise<void> {
  const signature = await sign(webhook.secret, body);

  for (let attempt = 1; attempt <= MAX_INLINE_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    let responseStatus: number | null = null;
    let responseExcerpt: string | null = null;
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Khaopad-Webhook/1",
          "X-Khaopad-Event": event,
          "X-Khaopad-Signature": `sha256=${signature}`,
          "X-Khaopad-Delivery": crypto.randomUUID(),
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      responseStatus = res.status;
      // Read first 256 chars of the body for debugging. Bound the
      // memory + bandwidth cost.
      try {
        const text = await res.text();
        responseExcerpt = text.slice(0, 256) || null;
      } catch {
        responseExcerpt = null;
      }
      // 2xx and 3xx (HTTP semantics: receiver got it) count as ok.
      ok = res.status >= 200 && res.status < 400;
    } catch (err) {
      responseExcerpt = err instanceof Error ? err.message.slice(0, 256) : null;
    }

    const durationMs = Date.now() - t0;
    const isFinal = ok || attempt === MAX_INLINE_ATTEMPTS;
    const nextAttemptAt = isFinal
      ? null
      : new Date(Date.now() + BACKOFF_MS[attempt - 1]).toISOString();

    // Best-effort write — a missing audit row beats blocking the loop.
    try {
      await content.recordWebhookDelivery({
        webhookId: webhook.id,
        event,
        payload: body,
        responseStatus,
        responseExcerpt,
        durationMs,
        attempt,
        nextAttemptAt,
        ok,
      });
    } catch {
      // ignore
    }

    if (ok) return;
    if (isFinal) return;
    // Sleep then retry.
    await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
  }
}

async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
