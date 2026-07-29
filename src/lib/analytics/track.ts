/**
 * Client-side track() — fires an event from the browser via
 * `navigator.sendBeacon` (or `fetch` fallback).
 *
 * The server derives context (path, session, locale, utm, country)
 * from the request; the client only sends event name + properties.
 * Keep-alive semantics ensure the beacon flushes even on page
 * unload — critical for `article_read` (fires on visibility change).
 *
 * Every call is safe on the server (no-op — `navigator` is undefined).
 * TypeScript enforces `properties` matches the event's catalog.
 */
import type { CanonicalEventName, EventProperties } from "./events";

const ENDPOINT = "/api/analytics/track";

/**
 * Fire an event to the analytics endpoint. Non-blocking; the browser
 * flushes on the next tick. Fails silently — a broken analytics pipe
 * never blocks UX.
 */
export function track<N extends CanonicalEventName>(
  name: N,
  properties: EventProperties<N>,
): void {
  if (typeof navigator === "undefined") return;
  const body = JSON.stringify({ name, properties });
  try {
    // sendBeacon is the right primitive for fire-and-forget: browser
    // flushes even during `visibilitychange`/`beforeunload`, so
    // article_read (fired on tab close) actually lands.
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(ENDPOINT, blob);
      if (ok) return;
    }
    // Fallback: fetch with keepalive.
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* swallow */
    });
  } catch {
    /* swallow — analytics failure never blocks UX */
  }
}
