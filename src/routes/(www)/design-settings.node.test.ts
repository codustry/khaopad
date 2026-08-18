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
    // default brand for a frame. Since #174 Step 5 the declaration is
    // built into themeStyle alongside the other tokens; assert both the
    // declaration and that themeStyle actually reaches the style
    // attribute (either half missing is a silently dead seam).
    expect(layout).toMatch(/--color-primary: \$\{themePrimaryColor\}/);
    expect(layout).toMatch(/style=\{themeStyle\}/);
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
  // The hero markup moved to DefaultHome.svelte when the homepage became a
  // resolver shell (#174 Step 6) — assertions follow the markup, same as the
  // logo test followed SiteHeader in Step 2.
  const home = readFileSync(
    here("../../lib/components/www/DefaultHome.svelte"),
    "utf8",
  );

  it("resolves hero copy per locale with en fallback", () => {
    expect(server).toContain("homepageHeroTitle");
    expect(server).toContain("homepageHeroSubtitle");
    expect(server).toMatch(/heroTitle\?\.\[locale\] \?\? heroTitle\?\.en/);
  });

  it("falls back to the Paraglide defaults when unset", () => {
    expect(home).toMatch(/data\.hero\?\.title \?\? m\.site_name\(\)/);
    expect(home).toMatch(/data\.hero\?\.subtitle \?\? m\.site_description\(\)/);
  });

  it("route resolves the home component from the registry with a default", () => {
    // The ?? fallback keeps an unconfigured install rendering normally; a
    // registered deployment home replaces the whole body while the route,
    // load and SEO stay engine-owned.
    expect(page).toMatch(/chrome\.home \?\? DefaultHome/);
    expect(page).toContain("<HomeComponent");
    // The markup must NOT creep back into the route file — that recreates
    // the same-file conflict this seam exists to end.
    expect(page).not.toContain("m.home_cta_shop");
  });
});

/**
 * #174 Step 5 — theme tokens promoted from CSS into operator config.
 *
 * Same wiring-pin rationale as above, plus BEHAVIORAL tests of the exact
 * validation regexes: every one of these strings is interpolated into an
 * inline style attribute on the public layout root, so the pins below are
 * the contract that nothing style-breaking can ever pass. The regex
 * literals are asserted present in the sources verbatim, then exercised
 * here against hostile inputs — so a "relaxed" regex fails twice.
 */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RADIUS_RE = /^\d+(?:\.\d+)?(?:px|rem|em)$/;
const FONT_RE = /^[A-Za-z0-9][A-Za-z0-9 ,-]{0,119}$/;

describe("(www) layout theme tokens (#174 Step 5)", () => {
  const layout = readFileSync(here("./+layout.svelte"), "utf8");

  const tokens: Array<[setting: string, cssProp: string]> = [
    ["themeBackgroundColor", "--color-background"],
    ["themeForegroundColor", "--color-foreground"],
    ["themeAccentColor", "--color-accent"],
    ["themeRadius", "--radius"],
    ["themeFontDisplay", "--font-display"],
  ];

  for (const [setting, cssProp] of tokens) {
    it(`reads ${setting} from site settings and emits ${cssProp}`, () => {
      expect(layout).toContain(`siteSettings?.${setting}`);
      // The declaration template — `--x: ${value}` — must exist AND feed
      // the decls array that becomes the style attribute.
      expect(layout).toContain(`\`${cssProp}: \${`);
    });
  }

  it("emits NO style attribute when no token is set (app.css defaults rule)", () => {
    // themeStyle collapses to undefined, so the SSR output of an
    // unthemed store is byte-identical to before the seam existed.
    expect(layout).toMatch(
      /decls\.length > 0 \? decls\.join\('; '\) : undefined/,
    );
  });

  it("re-validates every token before it reaches the style attribute", () => {
    // Defense in depth, same as themePrimaryColor: the layout must not
    // trust historical or hand-edited settings rows. The literal regex
    // sources must be present (behavior of each is pinned below).
    expect(layout).toContain(String(RADIUS_RE).slice(1, -1));
    expect(layout).toContain(String(FONT_RE).slice(1, -1));
    expect(layout).toContain("[0-9a-fA-F]{3}");
  });
});

describe("theme token validation regexes (behavior)", () => {
  it("hex: accepts #rgb/#rrggbb, rejects everything else", () => {
    expect(HEX_RE.test("#1a73e8")).toBe(true);
    expect(HEX_RE.test("#fff")).toBe(true);
    expect(HEX_RE.test("red")).toBe(false);
    expect(HEX_RE.test("#1a73e8; background: url(https://evil.example)")).toBe(
      false,
    );
    expect(HEX_RE.test("var(--x)")).toBe(false);
  });

  it("radius: accepts plain CSS lengths, rejects expressions and junk", () => {
    expect(RADIUS_RE.test("12px")).toBe(true);
    expect(RADIUS_RE.test("0.75rem")).toBe(true);
    expect(RADIUS_RE.test("1em")).toBe(true);
    expect(RADIUS_RE.test("0px")).toBe(true);
    expect(RADIUS_RE.test("-4px")).toBe(false);
    expect(RADIUS_RE.test("50%")).toBe(false);
    expect(RADIUS_RE.test("calc(1px + 1px)")).toBe(false);
    expect(RADIUS_RE.test("12px;color:red")).toBe(false);
  });

  it("font: accepts unquoted family lists, rejects style-attribute breakouts", () => {
    expect(FONT_RE.test("Playfair Display, serif")).toBe(true);
    expect(FONT_RE.test("IBM Plex Sans Thai, sans-serif")).toBe(true);
    // The canonical hostile value: would inject a second declaration and
    // an external fetch if it ever reached the style attribute.
    expect(FONT_RE.test("x;background:url(https://evil.example)")).toBe(false);
    expect(FONT_RE.test('"Playfair Display"')).toBe(false);
    expect(FONT_RE.test("a}body{display:none")).toBe(false);
    expect(FONT_RE.test("expression(alert(1))")).toBe(false);
    expect(FONT_RE.test("x".repeat(200))).toBe(false);
  });
});

describe("app.css token consumers (#174 Step 5)", () => {
  const css = readFileSync(here("../../app.css"), "utf8");

  it("derives the radius scale from the --radius base token", () => {
    expect(css).toMatch(/--radius:\s*0\.625rem/);
    expect(css).toContain("--radius-sm: calc(var(--radius) - 4px)");
    expect(css).toContain("--radius-lg: var(--radius)");
  });

  it("defines --font-display falling back to the sans stack, with a consumer", () => {
    expect(css).toContain("--font-display: var(--font-sans)");
    // Headings consume the token — without a consumer the setting would
    // be a dead knob.
    expect(css).toMatch(
      /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*font-family: var\(--font-display\)/,
    );
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

  it("gates every #174 Step 5 token with the strict validators", () => {
    // Form fields read…
    for (const field of [
      "theme_background_color",
      "theme_foreground_color",
      "theme_accent_color",
      "theme_radius",
      "theme_font_display",
    ]) {
      expect(action).toContain(field);
    }
    // …validated (colors share the hex gate loop; radius and font carry
    // their own regexes — asserted verbatim so a drive-by relaxation of
    // either regex fails this pin)…
    expect(action).toContain("themeBackgroundColor");
    expect(action).toContain("themeForegroundColor");
    expect(action).toContain("themeAccentColor");
    expect(action).toContain("^(\\d+(?:\\.\\d+)?)(px|rem|em)$");
    expect(action).toContain(String(FONT_RE).slice(1, -1));
    // …and persisted with empty-clears-to-undefined semantics.
    expect(action).toContain("themeRadius: themeRadius || undefined");
    expect(action).toContain("themeFontDisplay: themeFontDisplay || undefined");
  });
});
