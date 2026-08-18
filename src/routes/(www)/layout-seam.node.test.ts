/**
 * Pins the storefront chrome seam (#174 Step 2).
 *
 * The seam's value is that a deployment can replace header and footer WITHOUT
 * forking the layout — which only holds if the layout keeps reading the
 * registry and keeps rendering the non-overridable plumbing.
 *
 * These are source assertions rather than render tests. The repo's vitest
 * config is node-environment with no jsdom, so component rendering is not
 * available here. Render-level verification for this change was a
 * byte-identical SSR diff of /en, /en/products and /th (nonce-normalised),
 * plus the CSS inventory guard proving no Tailwind class was lost when the
 * markup moved files.
 *
 * What these catch is regression by deletion: someone inlining the header
 * again, or dropping the consent banner while refactoring.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  setChrome,
  getChrome,
  __resetChromeForTests,
} from "$lib/components/www/chrome";

const root = process.cwd();
const LAYOUT = readFileSync(
  join(root, "src/routes/(www)/+layout.svelte"),
  "utf8",
);

afterEach(() => __resetChromeForTests());

describe("chrome registry", () => {
  it("returns an empty object when nothing is registered", () => {
    // An install that registers nothing must fall through to the defaults —
    // not crash, and not render a headless page.
    expect(getChrome()).toEqual({});
  });

  it("accepts a header override without requiring a footer", () => {
    const Fake = (() => {}) as never;
    setChrome({ header: Fake });
    expect(getChrome().header).toBe(Fake);
    expect(getChrome().footer).toBeUndefined();
  });

  it("merges successive calls instead of replacing", () => {
    // A deployment may register chrome from more than one place; the second
    // call must not silently discard the first.
    const H = (() => {}) as never;
    const F = (() => {}) as never;
    setChrome({ header: H });
    setChrome({ footer: F });
    expect(getChrome()).toEqual({ header: H, footer: F });
  });
});

describe("(www) layout — chrome seam", () => {
  it("resolves chrome from the registry, falling back to the defaults", () => {
    // The ?? fallback is what makes an unconfigured install render normally.
    // Without it the seam would blank the page for every deployment that has
    // not registered anything — a visual-only failure.
    expect(LAYOUT).toContain("getChrome()");
    expect(LAYOUT).toMatch(/chrome\.header \?\? SiteHeader/);
    expect(LAYOUT).toMatch(/chrome\.footer \?\? SiteFooter/);
  });

  it("renders the resolved components, not the concrete defaults", () => {
    // If the markup referenced <SiteHeader> directly, registering an override
    // would typecheck, build, and do nothing at all.
    expect(LAYOUT).toContain("<HeaderComponent");
    expect(LAYOUT).toContain("<FooterComponent");
  });

  it("does NOT declare chrome as layout props", () => {
    // SvelteKit constructs layouts itself and passes only data/children, so
    // `header`/`footer` props can never be supplied. That was the first
    // design here; it built and rendered correctly precisely because the
    // fallback was always taken. eslint's valid-prop-names-in-kit-pages is
    // what caught it. Keep it caught.
    expect(LAYOUT).toMatch(/\$props\(\)/);
    expect(LAYOUT).not.toMatch(/header\?:\s*Snippet/);
    expect(LAYOUT).not.toMatch(/footer\?:\s*Snippet/);
  });

  it("passes the full documented context to whichever chrome renders", () => {
    for (const field of [
      "locale",
      "siteName",
      "logoMediaId",
      "primaryNav",
      "hasCareers",
      "cartItemCount",
      "alternateHref",
    ]) {
      expect(LAYOUT).toMatch(new RegExp(`${field}[,:]`));
    }
  });

  it("keeps SEO, consent and analytics OUTSIDE the overridable region", () => {
    // The point of the seam is that chrome is replaceable and these are not.
    // A theme that could drop the cookie banner or the canonical tags would be
    // a compliance and SEO hazard, so they live in the layout body.
    expect(LAYOUT).toContain("<Seo");
    expect(LAYOUT).toContain("<CookieBanner");
    expect(LAYOUT).toContain("cfaToken");
    // The theme-token style must survive too — it is what makes a re-branded
    // store render correctly on FIRST paint rather than flashing the default.
    expect(LAYOUT).toContain("--color-primary");
  });

  it("still renders page content between the chrome", () => {
    expect(LAYOUT).toContain("{@render children()}");
  });

  it("imports plugin registrations into the STOREFRONT CLIENT bundle", () => {
    // Without this side-effect import, setChrome()/slot registrations run
    // only server-side: SSR paints the custom chrome, hydration finds an
    // empty registry, and the header snaps back to the default. The admin
    // surface learned this lesson once already (sidebar-nav.ts documents
    // it); this pin stops the public surface relearning it.
    expect(LAYOUT).toMatch(/import ['"]\$lib\/plugins\/registrations['"]/);
  });
});
