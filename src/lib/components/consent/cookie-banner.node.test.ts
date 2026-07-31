import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards the cookie banner's "learn more" link.
 *
 * The href was hardcoded to `/[locale]/privacy-policy`, so any install
 * without a page at that slug shipped a **404 on its consent banner** —
 * the one link there that legally ought to resolve. Found by crawling
 * the deployed demo's links rather than by reading markup.
 *
 * Structural rather than a render test: the defect lives in how the
 * href is produced, and rendering the banner needs a full SvelteKit
 * data context for something these assertions cover directly.
 */
const BANNER = new URL("./CookieBanner.svelte", import.meta.url).pathname;
const LAYOUT = new URL("../../../routes/(www)/+layout.svelte", import.meta.url)
  .pathname;
const LAYOUT_SERVER = new URL(
  "../../../routes/(www)/+layout.server.ts",
  import.meta.url,
).pathname;

describe("cookie banner privacy link", () => {
  const banner = readFileSync(BANNER, "utf8");
  const layout = readFileSync(LAYOUT, "utf8");
  const layoutServer = readFileSync(LAYOUT_SERVER, "utf8");

  it("treats privacyHref as optional", () => {
    // A required prop forces callers to invent a URL even when no page
    // exists — which is exactly how the 404 shipped.
    expect(banner).toMatch(/privacyHref\?:\s*string/);
  });

  it("renders the link only when an href is supplied", () => {
    expect(banner).toMatch(/\{#if privacyHref\}/);
  });

  it("does not hardcode the privacy href in the layout", () => {
    // The layout must gate on real data, not assume the page exists.
    expect(layout).toMatch(/hasPrivacyPage/);
  });

  it("resolves the page from the database rather than assuming it", () => {
    // Looking it up means the link self-corrects when an operator
    // publishes or unpublishes the page — no redeploy, no config.
    expect(layoutServer).toMatch(/getPageBySlug\("privacy-policy"\)/);
    expect(layoutServer).toMatch(/hasPrivacyPage/);
  });

  it("requires the page to be published, not merely present", () => {
    // A draft privacy policy is not a privacy policy — linking to one
    // would 404 for anonymous visitors exactly as before.
    expect(layoutServer).toMatch(/status === "published"/);
  });
});
