import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

/**
 * Guards the shop-funnel localization structure (#141, #142, #144, #145).
 *
 * The funnel lived at unprefixed URLs, where Paraglide's `url` strategy
 * resolves the base locale before the cookie strategy is consulted — so
 * even fully-messaged pages hydrated back to English after a Thai SSR
 * flash, and the header language toggle 404'd (`/th/cart` didn't exist).
 * The pages moved under /[locale]/, with redirect stubs at the old URLs
 * because emails and the payment-return URL still target them.
 */
const R = (p: string) => new URL(`./${p}`, import.meta.url).pathname;
const read = (p: string) => readFileSync(R(p), "utf8");

const FUNNEL = ["cart", "checkout", "lookup", "order/[orderNumber]"];

describe("funnel routes live under [locale] (#141)", () => {
  for (const route of FUNNEL) {
    it(`${route}: page under [locale], stub at the old URL`, () => {
      expect(existsSync(R(`[locale]/${route}/+page.svelte`)), "page").toBe(
        true,
      );
      expect(existsSync(R(`${route}/+server.ts`)), "stub").toBe(true);
      // The old page must be GONE — two coexisting pages would shadow
      // the redirect and resurrect the hydration bug.
      expect(existsSync(R(`${route}/+page.svelte`)), "old page removed").toBe(
        false,
      );
    });
  }

  it("every stub preserves the query string", () => {
    // The order stub carries real auth: guests reach /order/[n]?email=…
    // from receipt emails, and the email param is what authorizes the
    // view. A stub that drops it bounces every guest to the lookup form.
    for (const route of FUNNEL) {
      expect(read(`${route}/+server.ts`), route).toContain("url.search");
    }
  });

  it("stubs derive the locale from the Paraglide cookie", () => {
    for (const route of FUNNEL) {
      const src = read(`${route}/+server.ts`);
      expect(src, route).toContain("cookieName");
      expect(src, route).toContain("localePath");
    }
  });
});

describe("funnel pages are localized and unindexable (#144)", () => {
  const PAGES = [
    "[locale]/cart/+page.svelte",
    "[locale]/checkout/+page.svelte",
    "[locale]/lookup/+page.svelte",
    "[locale]/order/[orderNumber]/+page.svelte",
  ];

  for (const page of PAGES) {
    it(`${page.split("/")[1]}: title, robots, and messages`, () => {
      const src = read(page);
      // Utility pages don't belong in a SERP; order URLs carry order
      // numbers. `follow` keeps outbound product links crawlable.
      expect(src).toContain('content="noindex, follow"');
      expect(src).toMatch(/<title>\{m\./);
      expect(src).toContain("$lib/paraglide/messages");
    });
  }

  it("cart never links to the demo product or a pinned /en/ path (#142)", () => {
    const src = read("[locale]/cart/+page.svelte");
    expect(src).not.toContain("classic-tee");
    expect(src).not.toContain('href="/en/');
    expect(src).toContain("localePath");
  });
});

describe("sitemap and robots (#144, #145)", () => {
  it("sitemap includes active products", () => {
    const src = readFileSync(
      new URL("../sitemap-[locale].xml/+server.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(src).toContain("ShopService");
    expect(src).toMatch(/status:\s*"active"/);
    // Best-effort: a site without shop tables still gets its sitemap.
    expect(src).toMatch(/catch/);
  });

  it("robots.txt fails closed when WORKERS_ENV is unset", () => {
    const src = readFileSync(
      new URL("../robots.txt/+server.ts", import.meta.url).pathname,
      "utf8",
    );
    // The old fallback was "production" — deploy a preview worker,
    // forget one var, and it competes with the real site in Google.
    expect(src).not.toMatch(/\?\?\s*\n?\s*"production"/);
  });

  it("non-production responses carry X-Robots-Tag", () => {
    const src = readFileSync(
      new URL("../../hooks.server.ts", import.meta.url).pathname,
      "utf8",
    );
    // robots.txt alone loses to Cloudflare's Content-Signals block
    // (Google prefers Allow on the tie); the header cannot be rewritten
    // by anything in front of the Worker.
    expect(src).toContain("X-Robots-Tag");
    expect(src).toContain("noindex, nofollow");
  });

  it("wrangler.toml declares WORKERS_ENV in every vars block", () => {
    const toml = readFileSync(
      new URL("../../../wrangler.toml", import.meta.url).pathname,
      "utf8",
    );
    // Failing closed without shipping the var would flip every install —
    // including real production ones — to noindex. Counted against the
    // vars blocks actually present: upstream ships three environments,
    // but a fork that trims to a single [vars] block (khaopad-example
    // does) must not fail this test for having fewer.
    const varsBlocks = toml.match(/^\[(?:env\.[a-z]+\.)?vars\]/gm) ?? [];
    const declarations = toml.match(/^WORKERS_ENV\s*=/gm) ?? [];
    expect(varsBlocks.length).toBeGreaterThanOrEqual(1);
    expect(declarations.length).toBe(varsBlocks.length);
  });
});

describe("funnel pages are never publicly cached (#146)", () => {
  // The catch-all cache branch served one visitor's rendered cart HTML —
  // and on /order/[n], their order details — to every visitor on the
  // same PoP for up to five minutes. It also made every cart mutation
  // look broken: the post-mutation reload re-served the pre-mutation
  // copy while D1 was correct the whole time.
  const hooks = readFileSync(
    new URL("../../hooks.server.ts", import.meta.url).pathname,
    "utf8",
  );

  it("cacheHook short-circuits funnel paths to no-store", () => {
    expect(hooks).toContain("isShopFunnelPath");
    expect(hooks).toMatch(
      /isShopFunnelPath\(path\)\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*value = "no-store"/,
    );
  });

  it("the matcher covers localized pages AND unprefixed stubs", () => {
    const fnMatch = hooks.match(/function isShopFunnelPath[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const re = fnMatch![0].match(/\/(\^.*?)\/\.test/)?.[1];
    expect(re).toBeTruthy();
    const matcher = new RegExp(re!);
    for (const p of [
      "/cart",
      "/en/cart",
      "/th/checkout",
      "/lookup",
      "/order/KHP-2026-00042",
      "/th/order/KHP-2026-00042",
    ]) {
      expect(matcher.test(p), p).toBe(true);
    }
    // And must NOT swallow lookalikes into no-store.
    for (const p of ["/en/blog/cart-reviews", "/carting", "/en/orders-faq"]) {
      expect(matcher.test(p), p).toBe(false);
    }
  });
});
