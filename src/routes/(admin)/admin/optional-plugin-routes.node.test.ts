import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  getEnabledPlugins,
  requirePluginEnabled,
} from "$lib/server/plugins/enabled";

/**
 * #193 — route guards for an optional plugin that is switched off.
 *
 * Hiding the nav is not sufficient. The reported failure mode is an
 * empty Products list that reads as broken data and invites an editor
 * to "fix" it by creating a product no storefront will ever show. A
 * bookmark, a history entry or a guessed URL all reach that list
 * without touching the sidebar, so the routes themselves must refuse.
 *
 * The guard helper is exercised behaviourally with a fake content
 * provider; the per-route WIRING is asserted structurally, because
 * invoking a real SvelteKit load would need the whole request context.
 */
const here = (p: string) => new URL(p, import.meta.url).pathname;
const read = (p: string) => readFileSync(here(p), "utf8");

const provider = (settings: Record<string, unknown>) => ({
  getSettings: async () => settings as never,
});

describe("requirePluginEnabled", () => {
  it("404s while the plugin is off", async () => {
    // 404 rather than 403: the route does not exist for this site, and
    // a 403 would leak that the feature is merely switched off.
    await expect(
      requirePluginEnabled(provider({}), "shop"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("passes once the operator enabled it", async () => {
    await expect(
      requirePluginEnabled(provider({ enabledPlugins: ["shop"] }), "shop"),
    ).resolves.toBeUndefined();
  });

  it("never blocks a non-optional plugin", async () => {
    await expect(
      requirePluginEnabled(provider({}), "reviews"),
    ).resolves.toBeUndefined();
  });
});

describe("getEnabledPlugins", () => {
  it("returns the empty set by default (fresh install)", async () => {
    expect(await getEnabledPlugins(provider({}))).toEqual([]);
  });

  it("fails CLOSED when the settings read throws", async () => {
    // A half-migrated install or a D1 hiccup must hide a nav group, not
    // 500 every admin page.
    const broken = {
      getSettings: async () => {
        throw new Error("no such table: site_settings");
      },
    };
    expect(await getEnabledPlugins(broken as never)).toEqual([]);
  });
});

describe("every shop-owned admin surface carries the guard", () => {
  it("gates the whole /admin/shop/* subtree from one layout load", () => {
    // A layout, not a line per page, so a shop route added later cannot
    // forget it.
    const layout = read("./shop/+layout.server.ts");
    expect(layout).toContain("requirePluginEnabled");
    expect(layout).toMatch(/"shop"/);
    expect(layout).toMatch(/export const load/);
  });

  it("gates /admin/reports (shop-owned despite living in the core nav group)", () => {
    const layout = read("./reports/+layout.server.ts");
    expect(layout).toContain("requirePluginEnabled");
    expect(layout).toMatch(/"shop"/);
  });

  it("repeats the guard in the CSV endpoint — +server.ts skips layout loads", () => {
    const csv = read("./reports/csv/+server.ts");
    expect(csv).toContain("requirePluginEnabled");
  });

  it("covers all four nav destinations named in the issue", () => {
    // products / collections / orders / discounts all live under
    // /admin/shop, so the subtree layout is what covers them; assert the
    // pages still live there rather than having escaped the guard.
    for (const p of ["products", "collections", "orders", "discounts"]) {
      expect(() => read(`./shop/${p}/+page.server.ts`)).not.toThrow();
    }
  });
});

describe("the dashboard Shop panel follows the same flag", () => {
  const dash = read("./dashboard/+page.server.ts");

  it("reads the operator's opt-in set, not the INSTALLED plugin list", () => {
    // The old gate consulted the INSTALLED plugin list, which always
    // contains shop — so it never fired and every site got a permanent
    // "THB 0.00" revenue panel.
    expect(dash).not.toContain("listEnabledPlugins");
    expect(dash).toContain("getEnabledPlugins");
    expect(dash).toMatch(/isPluginEnabled\(\s*\n?\s*"shop"/);
  });

  it("keeps the existing null path for a disabled shop", () => {
    // data.shop === null is what the page already renders "no panel"
    // from — the flag reuses it rather than adding a second mechanism.
    expect(dash).toMatch(/shopEnabled &&/);
    expect(dash).toMatch(/:\s*null;/);
  });
});

describe("the enabled set reaches the client consistently", () => {
  it("is resolved once in the admin layout load", () => {
    const layout = read("./+layout.server.ts");
    expect(layout).toContain("getEnabledPlugins");
    expect(layout).toMatch(/enabledPlugins:/);
  });

  it("is handed to BOTH nav consumers so they cannot disagree", () => {
    // The command palette reads the same registry as the sidebar; an
    // ungated palette would still offer "Products" and then 404.
    const shell = read("./+layout.svelte");
    expect(shell).toMatch(
      /<Sidebar[^>]*enabledPlugins=\{data\.enabledPlugins\}/,
    );
    expect(shell).toMatch(
      /<CommandPalette[^>]*enabledPlugins=\{data\.enabledPlugins\}/,
    );
  });
});

describe("the Features toggle in Settings", () => {
  const server = read("./settings/+page.server.ts");
  const page = read("./settings/+page.svelte");

  it("lists optional plugins from the manifests, not a hard-coded array", () => {
    expect(server).toMatch(/\.filter\(\(p\) => p\.optional\)/);
  });

  it("only accepts checkboxes for slugs that are actually installed", () => {
    // Iterating the known slug list (rather than scanning form keys for
    // a prefix) means a forged field cannot enable something absent.
    expect(server).toMatch(/OPTIONAL_PLUGIN_SLUGS\.filter/);
    expect(server).toMatch(/feature_\$\{slug\}/);
  });

  it("persists an EMPTY set rather than deleting the row", () => {
    // updateSettings treats undefined as a delete; collapsing [] to
    // undefined would make "switch everything off" un-saveable.
    expect(server).toMatch(/^\s*enabledPlugins,$/m);
    expect(server).not.toMatch(/enabledPlugins:.*\|\| undefined/);
  });

  it("renders a switch per optional plugin", () => {
    expect(page).toContain("cms_settings_features");
    expect(page).toMatch(/name=\{`feature_\$\{plugin\.slug\}`\}/);
  });

  it("audits the change — 'who turned the shop on?' must be answerable", () => {
    const auditBlock = server.slice(server.indexOf('"settings.update"'));
    expect(auditBlock).toContain("enabledPlugins");
  });
});
