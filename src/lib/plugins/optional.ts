/**
 * Opt-in plugin gate (#193) — the shared vocabulary for "installed but
 * not switched on".
 *
 * ## Why this is its own module
 *
 * It is imported from BOTH bundles and from the nav registry, so it may
 * not pull in anything server-only (`$lib/server/*`, D1, `env`) nor
 * anything Svelte-aware (`lucide-svelte`). Keeping it free of imports
 * entirely also keeps it out of the sidebar-nav ↔ registrations import
 * cycle that caused the two TDZ outages documented in
 * `$lib/components/admin/sidebar-nav.ts`.
 *
 * ## Where the enabled set lives
 *
 * In site settings (`SiteSettings.enabledPlugins`), same key/value
 * mechanism as every other operator toggle, so enabling a plugin is a
 * DB write and takes effect on the next request — no redeploy. It
 * reaches the browser through the admin layout's load, which already
 * runs on every admin navigation.
 *
 * ## Default is OFF, deliberately
 *
 * An absent setting means "no optional plugin is enabled". A fresh
 * install therefore ships lean, and an operator opts in explicitly.
 * The inverse default (absent = everything on) would make the flag
 * useless for exactly the deployments that filed the bug.
 */

/**
 * Slugs of the optional plugins in this build.
 *
 * A hand-maintained mirror of the `optional: true` manifests, for the
 * same reason `registrations.ts` mirrors `runtime.ts`: the manifest
 * objects live behind `lucide-svelte` imports, and the nav registry
 * (which needs this list) must stay importable from a plain unit test
 * and from the client bundle without Svelte-aware resolution.
 * `optional-plugins.node.test.ts` pins the two in sync.
 */
export const OPTIONAL_PLUGIN_SLUGS = ["shop"] as const;

export type OptionalPluginSlug = (typeof OPTIONAL_PLUGIN_SLUGS)[number];

/** Site-settings key holding the operator's enabled set. */
export const ENABLED_PLUGINS_SETTING_KEY = "enabledPlugins";

/**
 * Normalize whatever came out of site settings into a clean slug list.
 *
 * Tolerant on purpose: the value round-trips through JSON in a
 * `site_settings` text column, and a hand-edited row must degrade to
 * "nothing enabled" rather than throwing on every admin page load.
 * Unknown slugs are dropped so a stale setting left behind by an
 * uninstalled plugin cannot resurrect its nav.
 */
export function normalizeEnabledPlugins(value: unknown): OptionalPluginSlug[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(OPTIONAL_PLUGIN_SLUGS);
  const out: OptionalPluginSlug[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const slug = entry.trim();
    if (!known.has(slug)) continue;
    if (out.includes(slug as OptionalPluginSlug)) continue;
    out.push(slug as OptionalPluginSlug);
  }
  return out;
}

/**
 * Is `slug` active for this site?
 *
 * Non-optional plugins are always active — the gate only speaks about
 * slugs in `OPTIONAL_PLUGIN_SLUGS`, so callers can ask about any slug
 * without first checking whether it is optional.
 */
export function isPluginEnabled(
  slug: string,
  enabled: ReadonlyArray<string> | null | undefined,
): boolean {
  if (!(OPTIONAL_PLUGIN_SLUGS as ReadonlyArray<string>).includes(slug)) {
    return true;
  }
  return Boolean(enabled?.includes(slug));
}
