/**
 * Server-side resolution of the opt-in plugin set (#193).
 *
 * Split from `$lib/plugins/optional` because that module must stay
 * importable from the browser bundle; this one talks to the content
 * provider and is therefore server-only.
 */
import { error } from "@sveltejs/kit";
import {
  normalizeEnabledPlugins,
  isPluginEnabled,
  type OptionalPluginSlug,
} from "$lib/plugins/optional";
import type { ContentProvider } from "$lib/server/content/types";

/**
 * Read the operator's enabled set from site settings.
 *
 * Never throws: a settings read that fails (missing table on a
 * half-migrated install, D1 hiccup) degrades to "nothing optional is
 * enabled" rather than taking every admin page down. Failing CLOSED is
 * the safe direction here — the worst case is a hidden nav group an
 * operator can restore with one click, versus an admin that 500s.
 */
export async function getEnabledPlugins(
  content: Pick<ContentProvider, "getSettings">,
): Promise<OptionalPluginSlug[]> {
  try {
    const settings = await content.getSettings();
    return normalizeEnabledPlugins(settings.enabledPlugins);
  } catch {
    return [];
  }
}

/**
 * Route guard for pages owned by an optional plugin.
 *
 * 404, not 403: while the plugin is off, the route genuinely does not
 * exist for this site, and a bookmarked or guessed /admin/shop/products
 * must not render an empty product list — that empty list IS the data
 * trap #193 was filed about (an editor "fixes" it by creating a product
 * that no storefront reads). A 403 would also leak that the feature is
 * merely switched off, which is a distinction the URL guesser has no
 * business learning.
 */
export async function requirePluginEnabled(
  content: Pick<ContentProvider, "getSettings">,
  slug: string,
): Promise<void> {
  const enabled = await getEnabledPlugins(content);
  if (!isPluginEnabled(slug, enabled)) {
    throw error(404, "Not found");
  }
}
