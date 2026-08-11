/**
 * /[locale]/search?q= — combined storefront search results page.
 *
 * Two sections from two indexes:
 *   - Products: products_fts (trigram, Thai-substring-capable) via
 *     searchProducts() — active products only.
 *   - Articles: articles_fts via locals.content.searchArticles(),
 *     hydrated to ArticleRecord the same way /blog?q= does.
 */
import { toLocale } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import { logSearch } from "$lib/server/analytics";
import { drizzle } from "drizzle-orm/d1";
import { searchProducts, MIN_QUERY_LENGTH } from "$plugins/shop/search";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
  locals,
  params,
  url,
  platform,
}) => {
  const locale = toLocale(params.locale);
  const q = url.searchParams.get("q")?.trim() || null;
  const tooShort = q !== null && q.length < MIN_QUERY_LENGTH;

  let products: Awaited<ReturnType<typeof searchProducts>> = [];
  let articles: NonNullable<
    Awaited<ReturnType<typeof locals.content.getArticle>>
  >[] = [];

  if (q && !tooShort) {
    const [productHits, articleHits] = await Promise.all([
      platform?.env?.DB
        ? searchProducts(drizzle(platform.env.DB), {
            query: q,
            locale,
            limit: 12,
          })
        : Promise.resolve([]),
      locals.content.searchArticles(q, {
        locale,
        onlyPublished: true,
        onlyPublishedStatus: true,
        limit: 10,
      }),
    ]);
    products = productHits;

    // Hydrate article hits to ArticleRecord, keeping FTS rank order and
    // de-duping by article id (one article can match in both locales) —
    // same idiom as /blog?q=.
    const seen = new Set<string>();
    const orderedIds: string[] = [];
    for (const hit of articleHits) {
      if (seen.has(hit.articleId)) continue;
      seen.add(hit.articleId);
      orderedIds.push(hit.articleId);
    }
    const full = await Promise.all(
      orderedIds.map((id) => locals.content.getArticle(id)),
    );
    articles = full.filter((a): a is NonNullable<typeof a> => Boolean(a));

    if (platform?.env?.DB) {
      void logSearch(
        platform.env.DB,
        q,
        products.length === 0 && articles.length === 0,
      );
    }
  }

  // SEO: search results pages must not be indexed. Google's guidance
  // ("SEO starter guide" / Search Essentials: "block crawling of ...
  // search results pages, which provide little value to users coming
  // from search results") — noindex, but `follow` so link equity still
  // flows through to the product/article pages listed here.
  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);
  const seo: PageSeo = {
    title: q
      ? `${q} — ${settings?.siteName ?? "Khao Pad"}`
      : `Search — ${settings?.siteName ?? "Khao Pad"}`,
    description: "Search products and articles.",
    canonical: canonicalUrl(origin, `/${locale}/search`),
    locale,
    ogType: "website",
    robots: "noindex,follow",
  };

  return { locale, q, tooShort, products, articles, seo };
};
