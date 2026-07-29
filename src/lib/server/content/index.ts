import type { ContentProvider } from "./types";
import { D1ContentProvider } from "./providers/d1";

/**
 * Build the content provider for this request.
 *
 * The codebase ships with a single D1-backed provider — the
 * {@link ContentProvider} interface is kept so that future alternate
 * backends (in-memory for tests, etc.) can slot in without touching
 * call sites, but there is no runtime mode switch.
 */
export function createContentProvider(
  env: App.Platform["env"],
  ctx?: { waitUntil?: (p: Promise<unknown>) => void },
): ContentProvider {
  // CONTENT_CACHE is optional — passing it in lets the provider
  // invalidate cached populate payloads on write (Phase 1, #68 §D).
  // Without it the provider behaves exactly as it did before.
  //
  // `waitUntil` (from the Worker's execution context) keeps that
  // invalidation alive past the response. Absent it, invalidation still
  // runs, it just isn't guaranteed to finish.
  return new D1ContentProvider(
    env.DB,
    env.CONTENT_CACHE,
    ctx?.waitUntil ? ctx.waitUntil.bind(ctx) : undefined,
  );
}
