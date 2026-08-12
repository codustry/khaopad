/**
 * /[locale]/products/[slug] — public product detail page.
 *
 * Uses the site's locale-prefixed URL convention (matches
 * /[locale]/blog/[slug]) so hreflang alternates work automatically.
 * The canonical URL strips ?variant=<sku> — variants are query-param,
 * not path — so Google consolidates link equity to one URL per product.
 *
 * Owned by @khaopad/plugin-shop. This route lives here (in-tree) as
 * the v3.0 plugin-runtime convention: plugins drop route files into
 * src/routes/(www) or (admin) directly.
 */
import { error } from "@sveltejs/kit";
import { marked } from "marked";
import { toLocale } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import { ShopService } from "$plugins/shop/service";
import { relatedProducts } from "$plugins/shop/related";
import { buildProductJsonLd } from "$plugins/shop/jsonld";
import { ReviewService } from "$plugins/reviews/service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url, platform }) => {
  const locale = toLocale(params.locale);
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const svc = new ShopService(env.DB);
  const product = await svc.getProductBySlug(params.slug);
  if (!product) throw error(404, "Product not found");
  if (product.status !== "active") throw error(404, "Product not found");

  // Slug is shared across locales; fall back to English if the
  // requested locale's content is missing. Matches article convention.
  const localization =
    product.localizations[locale] ?? product.localizations["en"];
  if (!localization) throw error(404, "Product not available");
  // The fallback used to be silent: a Thai visitor got an English page
  // with no hint that a translation was simply missing. Surfaced to the
  // page as a flag so it can show an understated note.
  const localizationFellBack = !product.localizations[locale];

  // Selected variant from ?variant=<sku> query param. Falls back to
  // the first active variant if the SKU is unknown or missing.
  const skuParam = url.searchParams.get("variant");
  const activeVariants = product.variants.filter((v) => v.status === "active");
  const selectedVariant =
    (skuParam ? activeVariants.find((v) => v.sku === skuParam) : null) ??
    activeVariants[0];
  if (!selectedVariant) throw error(404, "No purchasable variants");

  // Origin used for canonical URL + JSON-LD. Prefer PUBLIC_SITE_URL
  // env when set (production), otherwise derive from the request URL.
  const origin = resolveOrigin(url, env.PUBLIC_SITE_URL);
  const canonical = canonicalUrl(origin, `/${locale}/products/${product.slug}`);

  // Markdown render and the related-products strip (#160 A5) are
  // independent of each other — run them in parallel rather than
  // serializing the page on the recommendation queries. A failed
  // recommendation must never 404/500 the product page, so it
  // degrades to an empty strip.
  // Reviews (#160 D2) degrade the same way as recommendations: a
  // broken reviews query must never take down the product page.
  const reviewSvc = new ReviewService(env.DB);
  const [descriptionHtml, related, reviews, reviewAggregate] =
    await Promise.all([
      localization.descriptionMarkdown
        ? marked.parse(localization.descriptionMarkdown, { async: true })
        : Promise.resolve(null),
      relatedProducts(env.DB, { productId: product.id }).catch((err) => {
        console.error("relatedProducts failed", err);
        return [];
      }),
      reviewSvc.listApproved(product.id).catch((err) => {
        console.error("listApproved reviews failed", err);
        return [];
      }),
      reviewSvc.getAggregate(product.id).catch((err) => {
        console.error("review aggregate failed", err);
        return { average: null, count: 0 };
      }),
    ]);

  // JSON-LD payload — one Offer per active variant OR AggregateOffer
  // when there are ≥2. Availability keys off computed available count.
  const jsonLd = buildProductJsonLd({
    siteOrigin: origin,
    slug: product.slug,
    title: localization.title,
    description: localization.descriptionMarkdown,
    brand: product.vendor,
    featuredImageUrl: null, // media resolution ships when the media picker lands for shop
    variants: activeVariants.map((v) => ({
      sku: v.sku,
      priceSatang: v.priceSatang,
      available: v.inventory?.available ?? 0,
    })),
    currency: "THB",
    // aggregateRating merges into the SAME Product node. The builder
    // refuses to emit it when there are no approved reviews.
    aggregateRating: {
      ratingValue: reviewAggregate.average,
      reviewCount: reviewAggregate.count,
    },
  });

  const seo: PageSeo = {
    title: product.seoTitle ?? localization.title,
    description:
      product.seoDescription ??
      (localization.descriptionMarkdown
        ? localization.descriptionMarkdown.slice(0, 200)
        : undefined),
    canonical,
    ogType: "product",
  };

  return {
    product: {
      // Canonical product id — analytics event tagging relies on this
      // so the per-product dashboard's queries by product.id resolve.
      // Previously fired with `product.slug` which broke the join.
      id: product.id,
      slug: product.slug,
      status: product.status,
      vendor: product.vendor,
      // For the recently-viewed capture (#160 A6) — the client stores
      // the thumbnail media id alongside title/price at view time.
      featuredMediaId: product.featuredMediaId,
      variants: activeVariants.map((v) => ({
        id: v.id,
        sku: v.sku,
        titleCached: v.titleCached,
        priceSatang: v.priceSatang,
        compareAtSatang: v.compareAtSatang,
        // For a bundle variant this is the DERIVED figure —
        // min(floor(component.available / qty)) — so the sold-out
        // badge, the variant picker's strike-through and the JSON-LD
        // availability all become bundle-correct with no branching
        // here. See hydrateProduct in service.ts.
        available: v.inventory?.available ?? 0,
        onHand: v.inventory?.onHand ?? 0,
        // #165 — bundle contents for the product page. Null for an
        // ordinary variant. Component stock is reduced to a boolean
        // in-stock flag: shoppers need to know WHICH item is holding
        // the bundle up, not the exact count of a thing they cannot
        // buy from this page.
        bundleComponents:
          v.bundleComponents?.map((c) => ({
            variantId: c.componentVariantId,
            quantity: c.quantity,
            title: c.productTitle,
            variantTitle: c.variantTitle,
            productSlug: c.productSlug,
            inStock: c.available === null || c.available >= c.quantity,
          })) ?? null,
        bundleComponentValueSatang: v.bundleComponentValueSatang,
      })),
      selectedVariantId: selectedVariant.id,
    },
    localization,
    localizationFellBack,
    descriptionHtml,
    // "You may also like" strip (#160 A5). Titles resolved to the
    // request locale server-side (en fallback, matching the page's own
    // localization rule) so the client renders plain strings.
    related: related.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.titles[locale] ?? r.titles["en"] ?? r.slug,
      priceFromSatang: r.priceFromSatang,
      mediaId: r.featuredMediaId,
    })),
    seo,
    jsonLd,
    locale,
    // Approved reviews only, with the reviewer's email reduced to a
    // display handle server-side — the raw address never reaches the
    // client payload.
    reviews: {
      average: reviewAggregate.average,
      count: reviewAggregate.count,
      items: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        verified: r.verified === 1,
        createdAt: r.createdAt,
        // "s***" style — enough for a repeat reviewer to recognise
        // themselves, useless for scraping addresses.
        author: `${r.email[0] ?? "?"}***`,
      })),
    },
  };
};
