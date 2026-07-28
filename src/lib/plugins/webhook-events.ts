/**
 * Webhook event registry — client-safe.
 *
 * Lives outside `$lib/server/` so plugin code (which loads in both
 * client and server bundles via `registrations.ts`) can call
 * `registerWebhookEvent()` without dragging server-only imports into
 * the browser bundle. Pure ES module — no D1, no drizzle, no env.
 *
 * The server-side types.ts re-exports these symbols so existing
 * imports (`from "$lib/server/content/types"`) keep working.
 */

/**
 * Events core knows how to fire. Autocompletes in editors; a typo
 * like `article.publisj` still errors. Plugins register their own
 * event names via `registerWebhookEvent()` — the union is widened to
 * accept arbitrary strings so plugin call sites typecheck.
 */
export type KnownWebhookEvent =
  | "article.publish"
  | "article.unpublish"
  | "article.delete"
  | "comment.approve"
  | "form.submit"
  | "subscriber.confirm";

/**
 * Any webhook event a plugin may fire. The `& {}` intersection
 * preserves autocomplete for `KnownWebhookEvent` while accepting
 * arbitrary strings from plugins (e.g. `shop.order.paid`). Plugin
 * events must be registered via `registerWebhookEvent()` so the admin
 * webhook-create form accepts them.
 */
export type WebhookEvent = KnownWebhookEvent | (string & {});

const CORE_WEBHOOK_EVENTS: readonly KnownWebhookEvent[] = [
  "article.publish",
  "article.unpublish",
  "article.delete",
  "comment.approve",
  "form.submit",
  "subscriber.confirm",
];

/**
 * Runtime registry — starts with core events; plugins append at boot
 * via `registerWebhookEvent()`. Consumed by the admin webhook-create
 * form (event picker + validation).
 */
const registeredWebhookEvents = new Set<WebhookEvent>(CORE_WEBHOOK_EVENTS);

/**
 * Register a plugin-owned webhook event so it appears in the admin
 * webhook-create UI. Idempotent — safe to call at every plugin boot.
 */
export function registerWebhookEvent(event: WebhookEvent): void {
  registeredWebhookEvents.add(event);
}

/**
 * All webhook events currently known — core + registered plugins.
 * Returns a fresh array each call to avoid consumers mutating the
 * internal set.
 */
export function listKnownWebhookEvents(): WebhookEvent[] {
  return Array.from(registeredWebhookEvents);
}

/**
 * @deprecated Use `listKnownWebhookEvents()`. Live Proxy for old imports.
 */
export const WEBHOOK_EVENTS = new Proxy([] as WebhookEvent[], {
  get(_target, prop, receiver) {
    return Reflect.get(listKnownWebhookEvents(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(listKnownWebhookEvents(), prop);
  },
  ownKeys(_target) {
    return Reflect.ownKeys(listKnownWebhookEvents());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(listKnownWebhookEvents(), prop);
  },
});
