/**
 * /[locale]/collections/[slug] — public collection page.
 *
 * Manual collections resolve via shop_collection_products join. Smart
 * collections' rules engine ships in a follow-up.
 */
import { error } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { marked } from "marked";
import { toLocale } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import {
  shopCollectionLocalizations,
  shopCollectionProducts,
  shopCollections,
  shopProductLocalizations,
  shopProductVariants,
  shopProducts,
} from "$plugins/shop/schema";
import { buildCollectionJsonLd } from "$plugins/shop/jsonld";
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
  // engine ships in a follow-up sub-PR)
  const links = await db
    .select()
    .from(shopCollectionProducts)
    .where(eq(shopCollectionProducts.collectionId, collection.id))
    .orderBy(shopCollectionProducts.position)
    .all();
  const productIds = links.map((l) => l.productId);

  const products = productIds.length
    ? await db
        .select()
        .from(shopProducts)
        .where(
          and(
            inArray(shopProducts.id, productIds),
            eq(shopProducts.status, "active"),
          ),
        )
        .all()
    : [];

  // Titles + price-from
  const productLocs = productIds.length
    ? await db
        .select()
        .from(shopProductLocalizations)
        .where(inArray(shopProductLocalizations.productId, productIds))
        .all()
    : [];
  const variants = productIds.length
    ? await db
        .select()
        .from(shopProductVariants)
        .where(
          and(
            inArray(shopProductVariants.productId, productIds),
            eq(shopProductVariants.status, "active"),
          ),
        )
        .all()
    : [];

  const locsByProduct = new Map<string, Map<string, { title: string }>>();
  for (const l of productLocs) {
    const map = locsByProduct.get(l.productId) ?? new Map();
    map.set(l.locale, { title: l.title });
    locsByProduct.set(l.productId, map);
  }
  const variantsByProduct = new Map<
    string,
    Array<typeof shopProductVariants.$inferSelect>
  >();
  for (const v of variants) {
    const arr = variantsByProduct.get(v.productId) ?? [];
    arr.push(v);
    variantsByProduct.set(v.productId, arr);
  }

  // Preserve manual collection ordering
  const orderedProducts = productIds
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is (typeof products)[number] => Boolean(p))
    .map((product) => {
      const locsMap = locsByProduct.get(product.id) ?? new Map();
      const title =
        locsMap.get(locale)?.title ??
        locsMap.get("en")?.title ??
        product.slug;
      const prices = (variantsByProduct.get(product.id) ?? []).map(
        (v) => v.priceSatang,
      );
      const priceFromSatang = prices.length ? Math.min(...prices) : null;
      return {
        slug: product.slug,
        title,
        priceFromSatang,
      };
    });

  const origin = resolveOrigin(url, env.PUBLIC_SITE_URL);
  const canonical = canonicalUrl(
    origin,
    `/${locale}/collections/${collection.slug}`,
  );

  const descriptionHtml = localization.descriptionMarkdown
    ? await marked.parse(localization.descriptionMarkdown, { async: true })
    : null;

  const jsonLd = buildCollectionJsonLd({
    siteOrigin: origin,
    slug: collection.slug,
    title: localization.title,
    description: localization.descriptionMarkdown,
    productSlugs: orderedProducts.map((p) => p.slug),
  });

  const seo: PageSeo = {
    title: collection.seoTitle ?? localization.title,
    description:
      collection.seoDescription ??
      (localization.descriptionMarkdown
        ? localization.descriptionMarkdown.slice(0, 200)
        : undefined),
    canonical,
    ogType: "website",
  };

  return {
    collection: {
      slug: collection.slug,
      title: localization.title,
    },
    products: orderedProducts,
    descriptionHtml,
    seo,
    jsonLd,
    locale,
  };
};
