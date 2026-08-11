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
  const [descriptionHtml, related] = await Promise.all([
    localization.descriptionMarkdown
      ? marked.parse(localization.descriptionMarkdown, { async: true })
      : Promise.resolve(null),
    relatedProducts(env.DB, { productId: product.id }).catch((err) => {
      console.error("relatedProducts failed", err);
      return [];
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
        available: v.inventory?.available ?? 0,
        onHand: v.inventory?.onHand ?? 0,
      })),
      selectedVariantId: selectedVariant.id,
    },
    localization,
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
  };
};
