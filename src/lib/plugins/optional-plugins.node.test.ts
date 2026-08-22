import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ENABLED_PLUGINS_SETTING_KEY,
  OPTIONAL_PLUGIN_SLUGS,
  isPluginEnabled,
  normalizeEnabledPlugins,
} from "./optional";

/**
 * #193 — opt-in plugins, default OFF.
 *
 * Filed from a downstream that sells nothing: the CMS showed
 * Shop → Products, it was empty, and the client read that as broken
 * data. Worse than cosmetic — creating a product there writes to
 * `shop_products`, which that deployment's storefront never reads.
 *
 * Behavioural assertions on the pure gate; STRUCTURAL assertions on the
 * wiring, following the precedent in `sidebar-nav.node.test.ts`:
 * importing the plugin manifests or the nav registry would drag
 * `lucide-svelte` (Svelte-aware resolution) into unit tests, and
 * vitest's module ordering does not reproduce the production bundle
 * anyway.
 */
const here = (p: string) => new URL(p, import.meta.url).pathname;
const read = (p: string) => readFileSync(here(p), "utf8");

describe("the gate itself", () => {
  it("defaults to OFF — an absent enabled set enables nothing optional", () => {
    // The whole bug in one assertion. If this ever flips, a fresh
    // install is back to showing an empty Products list.
    expect(isPluginEnabled("shop", undefined)).toBe(false);
    expect(isPluginEnabled("shop", null)).toBe(false);
    expect(isPluginEnabled("shop", [])).toBe(false);
  });

  it("enables an optional plugin only when its slug is in the set", () => {
    expect(isPluginEnabled("shop", ["shop"])).toBe(true);
    expect(isPluginEnabled("shop", ["careers"])).toBe(false);
  });

  it("leaves NON-optional plugins always active", () => {
    // The gate speaks only about optional slugs, so callers can ask
    // about any slug without checking first.
    expect(isPluginEnabled("hello", [])).toBe(true);
    expect(isPluginEnabled("reviews", [])).toBe(true);
    expect(isPluginEnabled("careers", undefined)).toBe(true);
  });

  it("lists shop as the optional plugin in this build", () => {
    expect([...OPTIONAL_PLUGIN_SLUGS]).toEqual(["shop"]);
  });

  it("stores the set under a stable settings key", () => {
    // Renaming this silently disables every site that had shop on.
    expect(ENABLED_PLUGINS_SETTING_KEY).toBe("enabledPlugins");
  });
});

describe("normalizeEnabledPlugins", () => {
  it("degrades a malformed setting to 'nothing enabled' rather than throwing", () => {
    // The value round-trips through JSON in a text column; a hand-edited
    // row must not take every admin page down.
    for (const bad of [undefined, null, "shop", 42, {}, NaN]) {
      expect(normalizeEnabledPlugins(bad)).toEqual([]);
    }
  });

  it("drops unknown slugs so a stale setting cannot resurrect nav", () => {
    expect(normalizeEnabledPlugins(["shop", "ghost-plugin"])).toEqual(["shop"]);
  });

  it("de-duplicates and trims", () => {
    expect(normalizeEnabledPlugins([" shop ", "shop"])).toEqual(["shop"]);
  });
});

describe("the manifest declares optionality (not a downstream sidebar edit)", () => {
  const shopIndex = read("../../plugins/shop/index.ts");
  const types = read("./types.ts");

  it("exposes `optional` on the plugin contract", () => {
    expect(types).toMatch(/optional\?:\s*boolean/);
  });

  it("marks the shop plugin optional", () => {
    expect(shopIndex).toMatch(/optional:\s*true/);
  });

  it("keeps OPTIONAL_PLUGIN_SLUGS in sync with the manifests", () => {
    // The slug list is a hand-maintained mirror (it must stay free of
    // lucide-svelte imports). This is the pin that keeps it honest.
    const optionalManifests = ["shop", "hello", "reviews", "careers"].filter(
      (slug) => /optional:\s*true/.test(read(`../../plugins/${slug}/index.ts`)),
    );
    expect(optionalManifests.sort()).toEqual([...OPTIONAL_PLUGIN_SLUGS].sort());
  });

  it("does NOT mark core-adjacent plugins optional", () => {
    for (const slug of ["hello", "reviews", "careers"]) {
      expect(read(`../../plugins/${slug}/index.ts`)).not.toMatch(
        /optional:\s*true/,
      );
    }
  });
});

describe("nav registration is gated at RENDER, not at registration", () => {
  const nav = read("../components/admin/sidebar-nav.ts");

  it("still registers plugin nav at module load", () => {
    // Making registration conditional on a DB read would require it to
    // be async, and the sidebar would render before plugin groups
    // exist — the exact bug the bottom-of-file side-effect import
    // exists to prevent.
    expect(read("../../plugins/shop/index.ts")).toMatch(/^registerNavGroup\(/m);
    expect(nav).toMatch(/import ["']\$lib\/plugins\/registrations["']/);
  });

  it("filters the snapshot by the enabled set instead", () => {
    expect(nav).toMatch(
      /export function listNavGroups\(\s*\n?\s*enabledPlugins/,
    );
    expect(nav).toContain("isPluginEnabled");
  });

  it("treats an omitted argument as 'do not gate', distinct from []", () => {
    // Structural: `undefined` must not collapse to "nothing enabled",
    // or callers wanting the installed set would get an empty nav.
    expect(nav).toMatch(/enabledPlugins === undefined/);
  });

  it("keeps the registry lazily constructed with `var` (TDZ guard intact)", () => {
    // This change touched the module the two production outages lived
    // in. Re-pin the invariants here so a future edit to the gate
    // cannot quietly undo them.
    expect(nav).toMatch(/var _registry:/);
    expect(nav).not.toMatch(/let _registry:/);
    expect(nav).not.toMatch(/^const registry\s*=\s*new Map/m);
  });
});

describe("the shop's /admin/reports item is gated too", () => {
  const shopIndex = read("../../plugins/shop/index.ts");

  it("tags the owning plugin on the item in the CORE 'main' group", () => {
    // Hiding the "shop" GROUP does not hide an item registered into a
    // core group, so the item carries its own owner.
    const block = shopIndex.slice(shopIndex.indexOf('registerNavItem("main"'));
    expect(block).toContain('"/admin/reports"');
    expect(block.slice(0, block.indexOf("});"))).toMatch(/plugin:\s*"shop"/);
  });
});
