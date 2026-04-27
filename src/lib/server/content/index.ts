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
): ContentProvider {
  return new D1ContentProvider(env.DB);
}
