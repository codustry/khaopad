import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildProductJsonLd } from "$plugins/shop/jsonld";

/**
 * #160 D2 — plugin-runtime registration pins for @khaopad/plugin-reviews,
 * plus the aggregateRating JSON-LD contract.
 *
 * Registration assertions are STRUCTURAL (source text), following the
 * precedent set in sidebar-nav.node.test.ts: importing the plugin
 * would drag lucide-svelte (Svelte-aware resolution) into unit tests,
 * and vitest's module ordering wouldn't reproduce production anyway.
 */
const here = (p: string) => new URL(p, import.meta.url).pathname;
const read = (p: string) => readFileSync(here(p), "utf8");

describe("reviews plugin registration", () => {
  const index = read("./index.ts");
  const registrations = read("../../lib/plugins/registrations.ts");
  const runtime = read("../../lib/plugins/runtime.ts");

  it("registers the review.approved webhook event at module load", () => {
    expect(index).toMatch(/registerWebhookEvent\("review\.approved"\)/);
  });

  it("contributes an /admin/reviews nav item to the shop group, editor+", () => {
    expect(index).toMatch(/registerNavItem\("shop",/);
    expect(index).toContain('"/admin/reviews"');
    // Editors moderate; authors don't.
    expect(index).toMatch(/roles:\s*\["super_admin",\s*"admin",\s*"editor"\]/);
  });

  it("is enabled in BOTH plugin lists (registrations + runtime)", () => {
    // The two lists must stay in sync — registrations.ts feeds the
    // client bundle, runtime.ts the server loader.
    expect(registrations).toMatch(/import reviews from "\$plugins\/reviews"/);
    expect(registrations).toMatch(/\[hello,\s*shop,\s*reviews\]/);
    expect(runtime).toMatch(/import reviews from "\$plugins\/reviews"/);
    expect(runtime).toMatch(/\[hello,\s*shop,\s*reviews\]/);
  });

  it("registers reviews AFTER shop so the shop nav group exists", () => {
    const shopIdx = registrations.indexOf('import shop from "$plugins/shop"');
    const reviewsIdx = registrations.indexOf(
      'import reviews from "$plugins/reviews"',
    );
    expect(shopIdx).toBeGreaterThanOrEqual(0);
    expect(reviewsIdx).toBeGreaterThan(shopIdx);
  });

  it("declares the plugin with the reviews slug", () => {
    expect(index).toMatch(/slug:\s*"reviews"/);
  });
});

describe("submission endpoint spam floor", () => {
  const route = readFileSync(
    here("../../routes/api/reviews/+server.ts"),
    "utf8",
  );

  it("keeps the honeypot check", () => {
    expect(route).toContain("HONEYPOT_FIELD");
    expect(route).toMatch(/hp\.trim\(\) !== ""/);
  });

  it("keeps the per-IP-hash rate limit at the shared threshold", () => {
    expect(route).toContain("hashIp");
    expect(route).toContain("RATE_LIMIT_MAX_PER_WINDOW");
    expect(route).toContain("RATE_LIMIT_WINDOW_SECONDS");
    expect(route).toContain("429");
  });

  it("never stores a raw IP", () => {
    expect(route).not.toMatch(/ipHash\s*=\s*ip\b/);
  });
});

describe("aggregateRating JSON-LD", () => {
  const base = {
    siteOrigin: "https://example.com",
    slug: "pad-thai-kit",
    title: "Pad Thai Kit",
    variants: [{ sku: "PT-1", priceSatang: 10000, available: 3 }],
  };

  it("emits aggregateRating inside the Product node when approved reviews exist", () => {
    const json = JSON.parse(
      buildProductJsonLd({
        ...base,
        aggregateRating: { ratingValue: 4.5, reviewCount: 12 },
      }).replace(/\\u003c/g, "<"),
    );
    expect(json["@type"]).toBe("Product");
    expect(json.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: "4.5",
      reviewCount: 12,
      bestRating: "5",
      worstRating: "1",
    });
  });

  it("emits NOTHING with zero approved reviews (no fabricated schema)", () => {
    const json = JSON.parse(
      buildProductJsonLd({
        ...base,
        aggregateRating: { ratingValue: null, reviewCount: 0 },
      }),
    );
    expect(json.aggregateRating).toBeUndefined();
  });

  it("emits nothing when the caller omits the field entirely", () => {
    const json = JSON.parse(buildProductJsonLd(base));
    expect(json.aggregateRating).toBeUndefined();
  });
});
