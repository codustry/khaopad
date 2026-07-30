/**
 * POST /api/analytics/track — client-side beacon receiver.
 *
 * Body: { name: CanonicalEventName, properties: Record<string, unknown> }
 *
 * Validates the event name against the canonical catalog (rejects
 * unknown names with 400), builds server-side context from the
 * request, and inserts into `events`.
 *
 * Cookie session id is used as the visitor identity — same cookie
 * as the shop cart (khaopad_shop_cart) so shop funnel events tie
 * to browsing events for the same visitor. If the cookie is absent,
 * one is minted here.
 */
import { json } from "@sveltejs/kit";
import { EVENT_METADATA } from "$lib/analytics/events";
import { buildEventContext, trackDynamic } from "$lib/server/analytics/track";
import { ensureCartSession } from "$plugins/shop/cart-cookie";
import { toLocale } from "$lib/i18n";
import type { RequestHandler } from "./$types";

const KNOWN_EVENTS = new Set(Object.keys(EVENT_METADATA));

export const POST: RequestHandler = async ({
  request,
  url,
  cookies,
  locals,
  platform,
}) => {
  const env = platform?.env;
  if (!env)
    return json({ ok: false, code: "PLATFORM_NOT_READY" }, { status: 503 });

  let body: { name?: unknown; properties?: unknown } | null;
  try {
    body = (await request.json()) as { name?: unknown; properties?: unknown };
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name : "";
  const properties =
    body?.properties && typeof body.properties === "object"
      ? (body.properties as Record<string, unknown>)
      : {};

  if (!name) {
    return json({ ok: false, code: "MISSING_NAME" }, { status: 400 });
  }
  if (!KNOWN_EVENTS.has(name)) {
    return json({ ok: false, code: "UNKNOWN_EVENT" }, { status: 400 });
  }

  // Reuse the shop cart cookie for session identity — one visitor,
  // one id across shop funnel + article reads. Ensures beacons from
  // visitors who never touched the shop still track.
  const sessionId = ensureCartSession(cookies);

  const locale = /^\/([a-z]{2})\//.exec(url.pathname)?.[1] ?? "en";
  const context = buildEventContext({
    url,
    request,
    sessionId,
    userId: locals.user?.id ?? null,
    locale: toLocale(locale),
  });

  await trackDynamic(env.DB, name, properties, context);
  return json({ ok: true });
};
