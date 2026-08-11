/**
 * /[locale]/products — storefront product index (issue #160 A1 + A4).
 *
 * Server-side facet filtering, sorting, and pagination over the active
 * catalog. All filter state lives in the URL query (shareable, back-
 * button-friendly); the pure pipeline in $lib/components/shop/browse
 * applies it. Facet dimensions: collection, price range, option
 * values, vendor, product type, availability — spec-attribute facets
 * plug in when products start carrying spec values (they don't yet;
 * see the note in browse.ts).
 *
 * KV cache: the assembled catalog (BrowseProduct[] + collections) is
 * cached in CONTENT_CACHE for 60s and only consulted for the bare,
 * unfiltered page-1 request — the common landing hit. Admin product
 * writes don't bump a generation for this key, so the short TTL is the
 * staleness bound (matches the facet API's own 60s cache-control).
 */
import { error } from "@sveltejs/kit";
import { toLocale, SUPPORTED_LOCALES } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import type { Locale } from "$lib/server/content/types";
import {
  buildFacets,
  filterProducts,
  paginateProducts,
  parseBrowseFilters,
  parseBrowsePage,
  parseBrowseSort,
  sortProducts,
  type BrowseProduct,
} from "$lib/components/shop/browse";
import {
  loadActiveCollections,
  loadBrowseProducts,
  type BrowseCollection,
} from "$lib/server/shop/browse";
import type { PageServerLoad } from "./$types";

const CACHE_KEY = "shop:browse:catalog:v1";
const CACHE_TTL_SECONDS = 60;

type CatalogPayload = {
  products: BrowseProduct[];
  collections: BrowseCollection[];
};

/**
 * Pagination + sort are canonical variants of the index; everything
 * else (facet selections) is a filter permutation that gets
 * noindex,follow — same policy as collections/[slug].
 */
const KNOWN_NON_FACET_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "gclid",
  "fbclid",
  "page",
  "sort",
]);

export const load: PageServerLoad = async ({
  locals,
  params,
  url,
  platform,
}) => {
  const locale = toLocale(params.locale);
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const bareRequest = Array.from(url.searchParams.keys()).length === 0;

  // ── Catalog (KV-cached for the bare landing request) ──
  let catalog: CatalogPayload | null = null;
  if (bareRequest) {
    try {
      catalog = await env.CONTENT_CACHE.get<CatalogPayload>(CACHE_KEY, "json");
    } catch {
      // A cache read must never break a page render.
    }
  }
  if (!catalog) {
    const [products, collections] = await Promise.all([
      loadBrowseProducts(env.DB),
      loadActiveCollections(env.DB),
    ]);
    catalog = { products, collections };
    if (bareRequest) {
      try {
        await env.CONTENT_CACHE.put(CACHE_KEY, JSON.stringify(catalog), {
          expirationTtl: CACHE_TTL_SECONDS,
        });
      } catch {
        // best-effort — a failed cache write is not a failed request
      }
    }
  }

  // ── Filter → sort → paginate (all server-side, all from the URL) ──
  const filters = parseBrowseFilters(url.searchParams);
  const sort = parseBrowseSort(url.searchParams);
  const filtered = sortProducts(
    filterProducts(catalog.products, filters),
    sort ?? "newest", // the index has no curated order — default to newest
  );
  const paged = paginateProducts(filtered, parseBrowsePage(url.searchParams));
  const facets = buildFacets(catalog.products, filters, {
    includeCollections: true,
  });

  const collectionTitles: Record<string, string> = {};
  for (const c of catalog.collections) {
    collectionTitles[c.slug] = c.titles[locale] ?? c.titles["en"] ?? c.slug;
  }

  // ── SEO — indexable money landing page ──
  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(
    url,
    env.PUBLIC_SITE_URL || settings?.cdnBaseUrl,
  );
  const canonical = canonicalUrl(
    origin,
    paged.page > 1
      ? `/${locale}/products?page=${paged.page}`
      : `/${locale}/products`,
  );
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    alternates[l] = canonicalUrl(origin, `/${l}/products`);
  }
  const hasFacetParam = Array.from(url.searchParams.keys()).some(
    (k) => !KNOWN_NON_FACET_PARAMS.has(k),
  );
  const siteName = settings?.siteName ?? "Khao Pad";
  const seo: PageSeo = {
    title: `${siteName} — Shop`,
    description: `Browse all products from ${siteName}. Filter by collection, price, and availability.`,
    canonical,
    locale,
    alternates,
    ogType: "website",
    robots: hasFacetParam ? "noindex,follow" : undefined,
  };

  return {
    locale,
    products: paged.items,
    page: paged.page,
    totalPages: paged.totalPages,
    total: paged.total,
    filters,
    sort,
    facets,
    collectionTitles,
    seo,
  };
};
