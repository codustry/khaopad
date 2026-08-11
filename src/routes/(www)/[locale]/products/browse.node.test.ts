import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Structural guards for the storefront browse surfaces (issue #160
 * A1/A2/A4): the pages exist, stay indexable, read their filter state
 * from the URL in the loader, and every facet the sidebar renders is
 * actually applied server-side. Behavior of the filter pipeline itself
 * is covered by $lib/components/shop/browse.test.ts.
 */
// decodeURIComponent: SvelteKit route dirs contain [brackets], which
// URL.pathname percent-encodes — the raw path would not resolve.
const read = (rel: string) =>
  readFileSync(
    decodeURIComponent(new URL(rel, import.meta.url).pathname),
    "utf8",
  );

const productsLoader = read("./+page.server.ts");
const productsPage = read("./+page.svelte");
const collectionsLoader = read("../collections/+page.server.ts");
const collectionsPage = read("../collections/+page.svelte");
const collectionLoader = read("../collections/[slug]/+page.server.ts");
const collectionPage = read("../collections/[slug]/+page.svelte");
const browseLogic = read("../../../../lib/components/shop/browse.ts");
const facetSidebar = read(
  "../../../../lib/components/shop/FacetSidebar.svelte",
);
const productCard = read("../../../../lib/components/shop/ProductCard.svelte");

describe("browse pages are indexable landing pages", () => {
  it("never noindexes the bare page — only facet permutations", () => {
    // The robots directive must be guarded by the facet-param check,
    // never unconditional. A bare /products or /collections/[slug]
    // is a money landing page.
    for (const src of [productsLoader, collectionLoader]) {
      expect(src).toMatch(/robots:\s*hasFacetParam\s*\?/);
      expect(src).not.toMatch(/robots:\s*["']noindex/);
    }
    expect(collectionsLoader).not.toMatch(/noindex/);
  });

  it("pagination and sort stay indexable (not facet params)", () => {
    for (const src of [productsLoader, collectionLoader]) {
      expect(src).toMatch(/"page"/);
      expect(src).toMatch(/"sort"/);
    }
  });

  it("emits hreflang alternates like the blog listing", () => {
    for (const src of [productsLoader, collectionsLoader, collectionLoader]) {
      expect(src).toMatch(/alternates/);
      expect(src).toMatch(/SUPPORTED_LOCALES/);
    }
  });
});

describe("filter state lives in the URL and is applied in the loader", () => {
  it.each([
    ["products index", productsLoader],
    ["collection page", collectionLoader],
  ])("%s parses filters/sort/page from url.searchParams", (_name, src) => {
    expect(src).toMatch(/parseBrowseFilters\(url\.searchParams\)/);
    expect(src).toMatch(/parseBrowseSort\(url\.searchParams\)/);
    expect(src).toMatch(/parseBrowsePage\(url\.searchParams\)/);
    expect(src).toMatch(/filterProducts\(/);
    expect(src).toMatch(/sortProducts\(/);
    expect(src).toMatch(/paginateProducts\(/);
    expect(src).toMatch(/buildFacets\(/);
  });

  it("only active products are browsable", () => {
    // The data layer hard-filters to status=active; both loaders go
    // through it rather than querying shop_products directly.
    const dataLayer = read("../../../../lib/server/shop/browse.ts");
    expect(dataLayer).toMatch(/eq\(shopProducts\.status, "active"\)/);
    expect(productsLoader).toMatch(/loadBrowseProducts\(/);
    expect(collectionLoader).toMatch(/loadBrowseProducts\(/);
  });
});

describe("every rendered facet has a WHERE application", () => {
  // Source-level pinning: each dimension the sidebar renders must have
  // a matching case in the pure filter. A facet that filters nothing
  // is a lie in the UI.
  const rendered: Array<[string, RegExp, RegExp]> = [
    ["collection", /facets\.collections/, /case "collection":/],
    ["vendor", /facets\.vendors/, /case "vendor":/],
    ["product type", /facets\.productTypes/, /case "type":/],
    ["price", /name="price_min"/, /case "price":/],
    ["availability", /toggleHref\('stock'/, /case "stock":/],
    ["option values", /facets\.options as group/, /p\.optionValues\[name\]/],
  ];

  it.each(rendered)("%s renders AND filters", (_name, renderRe, filterRe) => {
    expect(facetSidebar).toMatch(renderRe);
    expect(browseLogic).toMatch(filterRe);
  });

  it("filterProducts applies all dimensions together", () => {
    expect(browseLogic).toMatch(
      /dims\.every\(\(d\) => matchesDimension\(p, filters, d\)\)/,
    );
  });
});

describe("storefront rendering", () => {
  it("ProductCard links are localePath'd", () => {
    expect(productCard).toMatch(
      /localePath\(locale, `\/products\/\$\{product\.slug\}`\)/,
    );
  });

  it("ProductCard shows a sold-out badge and price", () => {
    expect(productCard).toMatch(/shop_browse_sold_out/);
    expect(productCard).toMatch(/formatSatang/);
  });

  it("collection cards are localePath'd", () => {
    expect(collectionsPage).toMatch(
      /localePath\(locale, `\/collections\/\$\{collection\.slug\}`\)/,
    );
  });

  it("empty states have real localized copy", () => {
    expect(productsPage).toMatch(/shop_browse_empty\(\)/);
    expect(productsPage).toMatch(/shop_browse_empty_filtered\(\)/);
    expect(collectionPage).toMatch(/shop_browse_empty_collection\(\)/);
    expect(collectionsPage).toMatch(/shop_browse_no_collections\(\)/);
  });

  it("grids go 2-col mobile → 4-col desktop", () => {
    expect(productsPage).toMatch(/grid-cols-2 .*xl:grid-cols-4/);
    expect(collectionPage).toMatch(/grid-cols-2 .*xl:grid-cols-4/);
  });

  it("active filters render as removable chips on both browse pages", () => {
    expect(productsPage).toMatch(/FilterChips/);
    expect(collectionPage).toMatch(/FilterChips/);
  });

  it("the messages files carry the browse keys in both locales", () => {
    for (const locale of ["en", "th"]) {
      const messages = JSON.parse(
        readFileSync(
          decodeURIComponent(
            new URL(`../../../../../messages/${locale}.json`, import.meta.url)
              .pathname,
          ),
          "utf8",
        ),
      ) as Record<string, string>;
      for (const key of [
        "nav_shop",
        "shop_browse_all_products",
        "shop_browse_sold_out",
        "shop_browse_empty",
        "shop_filter_title",
        "shop_filter_clear_all",
        "shop_filter_in_stock",
      ]) {
        expect(messages[key], `${locale}.json missing ${key}`).toBeTruthy();
      }
    }
  });
});
