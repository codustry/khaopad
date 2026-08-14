import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * #160 D6 — design-settings pins: two Khao Pad stores must be able to
 * look different without a fork.
 *
 * Structural (source) tests, same rationale as the admin design-system
 * suite: rendering the layout would need a full SvelteKit + Svelte
 * compile context; what actually regresses is the WIRING — a refactor
 * that stops reading the setting, or moves the color off the token the
 * rest of the CSS consumes. Those are text-visible properties.
 */
const here = (p: string) => new URL(p, import.meta.url).pathname;

describe("(www) layout theme wiring", () => {
  const layout = readFileSync(here("./+layout.svelte"), "utf8");

  it("reads themePrimaryColor from site settings", () => {
    expect(layout).toContain("siteSettings?.themePrimaryColor");
  });

  it("maps it onto --color-primary via an inline style (SSR, no FOUC)", () => {
    // Inline style on the root element: rendered into the first HTML
    // payload by SSR — never a client-side effect that would flash the
    // default brand for a frame.
    expect(layout).toMatch(/style=\{.*--color-primary/s);
    expect(layout).not.toMatch(/onMount\([^)]*--color-primary/s);
  });

  it("re-validates the hex before interpolating into the style attribute", () => {
    // Defense in depth: the settings action already rejects non-hex,
    // but the layout must not trust historical/hand-edited rows.
    expect(layout).toContain("[0-9a-fA-F]");
  });

  it("renders the configured logo in the header", () => {
    // The layout resolves the media id and hands it to whichever chrome
    // renders; the <img> itself moved to SiteHeader.svelte with the rest of
    // the header when the chrome seam landed (#174 Step 2). Assert both
    // halves, so neither the resolution nor the rendering can be dropped
    // without a test noticing.
    expect(layout).toContain("themeLogoMediaId");
    expect(layout).toMatch(/logoMediaId:\s*themeLogoMediaId/);

    const header = readFileSync(
      here("../../lib/components/www/SiteHeader.svelte"),
      "utf8",
    );
    expect(header).toMatch(/\/api\/media\/\$\{logoMediaId\}/);
  });
});

describe("homepage hero wiring", () => {
  const server = readFileSync(here("./[locale]/+page.server.ts"), "utf8");
  const page = readFileSync(here("./[locale]/+page.svelte"), "utf8");

  it("resolves hero copy per locale with en fallback", () => {
    expect(server).toContain("homepageHeroTitle");
    expect(server).toContain("homepageHeroSubtitle");
    expect(server).toMatch(/heroTitle\?\.\[locale\] \?\? heroTitle\?\.en/);
  });

  it("falls back to the Paraglide defaults when unset", () => {
    expect(page).toMatch(/data\.hero\?\.title \?\? m\.site_name\(\)/);
    expect(page).toMatch(/data\.hero\?\.subtitle \?\? m\.site_description\(\)/);
  });
});

describe("settings action hex gate", () => {
  const action = readFileSync(
    here("../(admin)/admin/settings/+page.server.ts"),
    "utf8",
  );

  it("rejects non-hex primary colors before they can reach the layout", () => {
    expect(action).toContain("theme_primary_color");
    expect(action).toContain("[0-9a-fA-F]{6}");
    expect(action).toContain("themePrimaryColor");
    expect(action).toContain("themeLogoMediaId");
  });
});
