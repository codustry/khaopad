import type { ContentProvider, Locale } from "./types";

/**
 * Reusable-content-block shortcode (v1.7).
 *
 * Editors paste `{{block:my-key}}` into article/page bodies. Before
 * `marked` runs, this helper expands every shortcode to the matching
 * `content_blocks` body for the requested locale (falling back to
 * English when the requested locale is missing).
 *
 * Unknown keys are replaced with an HTML comment so we never crash
 * the render but the editor sees something happened. Designed to be
 * cheap on the happy path: the regex bails immediately if the body
 * has no `{{block:` substring.
 *
 * Example:
 *
 *   await expandBlocks(content.body, content, "en")
 *
 * The shortcode itself is intentionally non-markdown: `{{ … }}` survives
 * `marked` if missed (just renders as literal text), instead of being
 * silently swallowed by the parser.
 */
const SHORTCODE_RE = /\{\{block:([a-z0-9-]+)\}\}/g;

export async function expandBlocks(
  body: string,
  content: ContentProvider,
  locale: Locale,
): Promise<string> {
  if (!body.includes("{{block:")) return body;

  // Resolve all referenced keys in one pass so we don't hit D1 N times.
  const keys = Array.from(body.matchAll(SHORTCODE_RE), (m) => m[1]);
  const unique = Array.from(new Set(keys));
  const resolved = new Map<string, string>();
  for (const key of unique) {
    const block = await content.getContentBlockByKey(key);
    if (!block) continue;
    const loc = block.localizations[locale] ?? block.localizations.en;
    resolved.set(key, loc?.body ?? "");
  }

  return body.replace(SHORTCODE_RE, (_, key: string) => {
    if (resolved.has(key)) return resolved.get(key)!;
    return `<!-- unknown block: ${key} -->`;
  });
}
