/**
 * /[locale]/collections/[slug] — public collection browse page.
 *
 * v3.14 (#160 A2/A4): upgraded from a bare product list to the full
 * browse surface — facet filtering (price, option values, vendor,
 * product type, availability), sorting, and pagination, all URL-driven
 * and applied server-side via the shared pipeline in
 * $lib/components/shop/browse. Default ordering (no ?sort=) is the
 * collection's manual curation order.
 *
 * Manual collections resolve via shop_collection_products join. Smart
 * collections' rules engine ships in a follow-up.
 */
import { error } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { marked } from "marked";
import { toLocale, SUPPORTED_LOCALES } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import type { Locale } from "$lib/server/content/types";
import {
  shopCollectionLocalizations,
  shopCollectionProducts,
  shopCollections,
} from "$plugins/shop/schema";
import { buildCollectionJsonLd } from "$plugins/shop/jsonld";
import {
  buildFacets,
  filterProducts,
  paginateProducts,
  parseBrowseFilters,
  parseBrowsePage,
  parseBrowseSort,
  sortProducts,
} from "$lib/components/shop/browse";
import { loadBrowseProducts } from "$lib/server/shop/browse";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url, platform }) => {
  const locale = toLocale(params.locale);
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const db = drizzle(env.DB);

  // 1) The collection itself
  const collection = await db
    .select()
    .from(shopCollections)
    .where(eq(shopCollections.slug, params.slug))
    .limit(1)
    .get();
  if (!collection || collection.status !== "active") {
    throw error(404, "Collection not found");
  }

  // 2) Localization (English fallback)
  const locs = await db
    .select()
    .from(shopCollectionLocalizations)
    .where(eq(shopCollectionLocalizations.collectionId, collection.id))
    .all();
  const localization =
    locs.find((l) => l.locale === locale) ??
    locs.find((l) => l.locale === "en");
  if (!localization) throw error(404, "Collection not available");

  // 3) Products in the collection (manual only for now — smart rules
  // engine ships in a follow-up sub-PR), hydrated to BrowseProduct and
  // re-ordered back into the curated position order (loadBrowseProducts
  // does not preserve input order).
  const links = await db
    .select()
    .from(shopCollectionProducts)
    .where(eq(shopCollectionProducts.collectionId, collection.id))
    .orderBy(shopCollectionProducts.position)
    .all();
  const orderedIds = links.map((l) => l.productId);
  const positionById = new Map(orderedIds.map((id, i) => [id, i]));

  const allProducts = (
    await loadBrowseProducts(env.DB, { productIds: orderedIds })
  ).sort(
    (a, b) => (positionById.get(a.id) ?? 0) - (positionById.get(b.id) ?? 0),
  );

  // 4) Filter → sort → paginate. No collection facet here — the page
  // IS the collection. sort=null keeps the manual curation order.
  const filters = parseBrowseFilters(url.searchParams);
  const sort = parseBrowseSort(url.searchParams);
  const filtered = sortProducts(filterProducts(allProducts, filters), sort);
  const paged = paginateProducts(filtered, parseBrowsePage(url.searchParams));
  const facets = buildFacets(allProducts, filters);

  const origin = resolveOrigin(url, env.PUBLIC_SITE_URL);
  const canonical = canonicalUrl(
    origin,
    `/${locale}/collections/${collection.slug}`,
  );
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    alternates[l] = canonicalUrl(
      origin,
      `/${l}/collections/${collection.slug}`,
    );
  }

  const descriptionHtml = localization.descriptionMarkdown
    ? await marked.parse(localization.descriptionMarkdown, { async: true })
    : null;

  const jsonLd = buildCollectionJsonLd({
    siteOrigin: origin,
    slug: collection.slug,
    title: localization.title,
    description: localization.descriptionMarkdown,
    productSlugs: filtered.map((p) => p.slug),
  });

  // v3.3 SEO polish: any filter/facet query param (e.g. ?opt.Size=M,
  // ?price_min=100) turns the URL into a facet page — mark
  // noindex,follow so Google follows out-links but doesn't index the
  // filter permutation. Prevents crawl-budget bleed. Canonical still
  // points at the base collection URL so link equity consolidates.
  // Marketing tokens + pagination + sort are NOT facets and stay
  // indexable; the bare collection page never gets a robots meta.
  const KNOWN_NON_FACET_PARAMS = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "gclid",
    "fbclid",
    "page", // pagination — /collections/tees?page=2 must stay indexable
    "sort", // sort variant of a canonical collection
  ]);
  const hasFacetParam = Array.from(url.searchParams.keys()).some(
    (k) => !KNOWN_NON_FACET_PARAMS.has(k),
  );

  const seo: PageSeo = {
    title: collection.seoTitle ?? localization.title,
    description:
      collection.seoDescription ??
      (localization.descriptionMarkdown
        ? localization.descriptionMarkdown.slice(0, 200)
        : undefined),
    canonical,
    locale,
    alternates,
    ogType: "website",
    robots: hasFacetParam ? "noindex,follow" : undefined,
  };

  return {
    collection: {
      slug: collection.slug,
      title: localization.title,
    },
    products: paged.items,
    page: paged.page,
    totalPages: paged.totalPages,
    total: paged.total,
    filters,
    sort,
    facets,
    descriptionHtml,
    seo,
    jsonLd,
    locale,
  };
};
