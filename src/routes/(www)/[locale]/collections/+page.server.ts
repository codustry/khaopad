/**
 * /[locale]/collections — storefront collections index (issue #160 A2).
 *
 * Grid of active collections with localized titles + active-product
 * counts, linking through to /collections/[slug]. Indexable — this is
 * a money landing page.
 */
import { error } from "@sveltejs/kit";
import { toLocale, SUPPORTED_LOCALES } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import type { Locale } from "$lib/server/content/types";
import { loadActiveCollections } from "$lib/server/shop/browse";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
  locals,
  params,
  url,
  platform,
}) => {
  const locale = toLocale(params.locale);
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const collections = (await loadActiveCollections(env.DB)).map((c) => ({
    slug: c.slug,
    featuredMediaId: c.featuredMediaId,
    title: c.titles[locale] ?? c.titles["en"] ?? c.slug,
    productCount: c.productCount,
  }));

  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(
    url,
    env.PUBLIC_SITE_URL || settings?.cdnBaseUrl,
  );
  const canonical = canonicalUrl(origin, `/${locale}/collections`);
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    alternates[l] = canonicalUrl(origin, `/${l}/collections`);
  }
  const siteName = settings?.siteName ?? "Khao Pad";
  const seo: PageSeo = {
    title: `${siteName} — Collections`,
    description: `Shop ${siteName} by collection.`,
    canonical,
    locale,
    alternates,
    ogType: "website",
  };

  return { locale, collections, seo };
};
