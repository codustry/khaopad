/**
 * Server-side track() — records a canonical event to D1.
 *
 * Called from:
 *   - `+page.server.ts` load functions (page_view auto-instrumentation
 *     via hooks.server.ts on public routes)
 *   - `+page.server.ts` form actions (comment_submit, form_submit)
 *   - Webhook handlers (purchase, refund — from the shop plugin)
 *   - `/api/analytics/track` POST endpoint (browser sendBeacon for
 *     article_read, cta_click, add_to_cart, product_view, etc.)
 *
 * Errors are swallowed with a warn log. Analytics failures never
 * block real user flows — a broken tracking pipeline still lets
 * people buy stuff.
 */
import { drizzle } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { events, type EventRow } from "./events-schema";
import type {
  CanonicalEvent,
  CanonicalEventName,
  EventContext,
  EventProperties,
} from "$lib/analytics/events";

/**
 * Type-safe server track. TypeScript enforces `properties` matches
 * the named event's contract — a `track("purchase", {})` call fails
 * at compile time because `orderId`/`orderNumber`/etc. are required.
 */
export async function track<N extends CanonicalEventName>(
  d1: D1Database,
  name: N,
  properties: EventProperties<N>,
  context: EventContext,
): Promise<void> {
  try {
    const db = drizzle(d1);
    const props = properties as { articleId?: string; productId?: string };
    const row: EventRow = {
      id: nanoid(),
      name,
      propertiesJson: JSON.stringify(properties),
      contextJson: JSON.stringify(context),
      ts: context.ts,
      sessionId: context.sessionId,
      userId: context.userId ?? null,
      articleId: props.articleId ?? null,
      productId: props.productId ?? null,
    };
    await db.insert(events).values(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[analytics] track(${name}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Escape hatch for plugin-registered events that aren't in the
 * CanonicalEvent union. Untyped properties, but goes through the
 * same storage path. Prefer `track()` above whenever the event is
 * in the catalog — the type-safety is the point.
 */
export async function trackDynamic(
  d1: D1Database,
  name: string,
  properties: Record<string, unknown>,
  context: EventContext,
): Promise<void> {
  try {
    const db = drizzle(d1);
    const row: EventRow = {
      id: nanoid(),
      name,
      propertiesJson: JSON.stringify(properties),
      contextJson: JSON.stringify(context),
      ts: context.ts,
      sessionId: context.sessionId,
      userId: context.userId ?? null,
      articleId: (properties.articleId as string | undefined) ?? null,
      productId: (properties.productId as string | undefined) ?? null,
    };
    await db.insert(events).values(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[analytics] trackDynamic(${name}) failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Build the full EventContext for a server-side track call. Extracts
 * the request-derived fields (path, referrer, utm, country, user-
 * agent) so the caller only supplies session/user identity.
 *
 * Callers on public routes typically get sessionId from the shop
 * cart cookie (`readCartSession`) or the analytics session cookie.
 */
export function buildEventContext(input: {
  url: URL;
  request: Request;
  sessionId: string;
  userId?: string | null;
  locale?: string;
}): EventContext {
  // Extract utm inline to avoid the client-safe events module dep here.
  const utm: Record<string, string> = {};
  for (const key of ["source", "medium", "campaign", "term", "content"] as const) {
    const v = input.url.searchParams.get(`utm_${key}`);
    if (v) utm[key] = v.slice(0, 200);
  }
  const userAgent = input.request.headers.get("user-agent");
  const country = input.request.headers.get("cf-ipcountry");
  return {
    path: input.url.pathname + (input.url.search || ""),
    ts: new Date().toISOString(),
    sessionId: input.sessionId,
    userId: input.userId ?? null,
    locale: input.locale ?? "en",
    referrer: input.request.headers.get("referer"),
    utm: Object.keys(utm).length > 0 ? utm : undefined,
    userAgent: userAgent ? userAgent.slice(0, 256) : null,
    country,
  };
}
