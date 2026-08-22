/**
 * Plugin contract for Khao Pad v3.0.
 *
 * A plugin is an object satisfying `KhaopadPlugin`. It contributes
 * additively to core: sidebar nav entries, audit actions, webhook
 * events, and (via file placement, not runtime API) routes + migrations.
 *
 * File placement rules (v3.0 — in-tree plugins):
 *   src/plugins/<slug>/index.ts               ← this file exports defineKhaopadPlugin({...})
 *   src/plugins/<slug>/schema.ts              ← Drizzle table defs, if any
 *   src/routes/(admin)/admin/<slug>/          ← admin routes (owned by plugin)
 *   drizzle/plugin_<slug>_NNNN_desc.sql       ← migrations (wrangler runs in filename order)
 *
 * Runtime: the loader calls `onInit(ctx)` once per Worker cold start.
 * Plugins register into core registries (sidebar nav, webhook events)
 * from `onInit`. Never long-lived work — this runs on every cold start.
 */

/** Minimal context passed to a plugin's onInit hook. */
export type PluginInitContext = {
  /** Environment bindings (D1, R2, KV, secrets). Same shape as `App.Platform["env"]`. */
  env: App.Platform["env"];
};

/**
 * A Khao Pad plugin. Use `defineKhaopadPlugin()` for autocomplete;
 * this raw type is exported for downstream typing.
 */
export type KhaopadPlugin = {
  /**
   * Unique kebab-case slug. Used as:
   * - Route folder name: `/admin/<slug>/`
   * - Migration filename prefix: `plugin_<slug>_NNNN_desc.sql`
   * - Table name prefix convention: `<slug>_*` (soft — enforced by review, not code)
   * - Sidebar nav group id: `<slug>`
   *
   * Must match: `/^[a-z][a-z0-9-]*$/`
   */
  slug: string;

  /** Human-readable name shown in Plugins list UI (future). */
  name: string;

  /** SemVer plugin version. Not enforced today; wired for `khaopadCompat` check later. */
  version: string;

  /** Optional one-liner shown in Plugins list UI. */
  description?: string;

  /**
   * Opt-in plugin (#193). When true the plugin is INSTALLED but not
   * ACTIVE until an operator switches it on in Settings → Features;
   * the enabled set lives in site settings under `enabledPlugins`.
   *
   * The distinction matters because "installed" is a build-time fact
   * (the import is in registrations.ts) while "this site actually uses
   * it" is a per-deployment fact. Conflating them is what produced the
   * reported bug: a site that sells nothing still saw Shop → Products,
   * found it empty, and read it as broken data. Worse, it is a data
   * trap — creating a product there writes to `shop_products`, which
   * a non-shop deployment's storefront never reads.
   *
   * Declaring it here rather than in each downstream's sidebar edits
   * keeps the decision in the plugin manifest (the ownership seam
   * argued in #173).
   *
   * Omitted/false = core-adjacent plugin, always active once installed.
   */
  optional?: boolean;

  /**
   * Called once per Worker cold start, after core auth + bindings are
   * ready. Register into sidebar nav, webhook events, audit actions
   * here. Do NOT do slow work — this runs on every cold start.
   * Errors are logged but do not crash the request.
   */
  onInit?: (ctx: PluginInitContext) => void | Promise<void>;
};

/**
 * Identity helper for plugin authors. Preserves inference without
 * requiring an explicit type annotation:
 *
 *   export default defineKhaopadPlugin({
 *     slug: "hello",
 *     name: "Hello",
 *     version: "0.1.0",
 *     onInit(ctx) { ... },
 *   });
 */
export function defineKhaopadPlugin(plugin: KhaopadPlugin): KhaopadPlugin {
  if (!/^[a-z][a-z0-9-]*$/.test(plugin.slug)) {
    throw new Error(
      `Plugin slug "${plugin.slug}" must match /^[a-z][a-z0-9-]*$/`,
    );
  }
  return plugin;
}
