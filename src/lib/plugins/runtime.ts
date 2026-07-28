/**
 * Plugin loader — runs once per Worker cold start.
 *
 * Discovery is static (Vite tree-shakes the imports). Plugins register
 * themselves into core registries (sidebar nav, webhook events, audit
 * actions) from their `onInit` hook.
 *
 * Adding a plugin: add its default export to `enabledPlugins` below.
 * A future v3.5 will replace this with npm discovery via package.json
 * `khaopad.plugins`; keeping it explicit for now avoids build-time magic.
 */
import type { KhaopadPlugin, PluginInitContext } from "./types";
// Ensure side-effect module-load registrations (sidebar nav, webhook
// events) run in the server bundle too. The client bundle triggers the
// same import chain via sidebar-nav.ts. See registrations.ts for the
// rationale (single source of truth for the enabled-plugins set).
import "./registrations";

// ─── Enabled plugins ────────────────────────────────────────
// Order matters: earlier plugins init first, so their sidebar groups
// appear above later plugins'. Core groups (registered in
// $lib/components/admin/sidebar-nav.ts) always come first.
//
// Keep this list in sync with the imports in registrations.ts.

import hello from "$plugins/hello";
import shop from "$plugins/shop";

const enabledPlugins: KhaopadPlugin[] = [hello, shop];

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Idempotent: safe to call from every hook invocation.
 * The Worker isolate persists across requests within a cold-start
 * lifetime, so this runs once per isolate.
 */
export async function initPlugins(ctx: PluginInitContext): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      for (const plugin of enabledPlugins) {
        try {
          await plugin.onInit?.(ctx);
        } catch (err) {
          // Never crash a request over a plugin init failure. Log and continue.
          // eslint-disable-next-line no-console
          console.error(
            `[plugins] ${plugin.slug} onInit failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      // Mark init done even on unexpected outer throws so we don't
      // pin every future request to a rejected promise.
      initialized = true;
    }
  })();

  return initPromise;
}

/** For tests + the future Plugins admin page. */
export function listEnabledPlugins(): ReadonlyArray<KhaopadPlugin> {
  return enabledPlugins;
}
