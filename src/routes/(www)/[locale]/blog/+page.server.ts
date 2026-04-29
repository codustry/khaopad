import { toLocale, SUPPORTED_LOCALES } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import type { Locale } from "$lib/server/content/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const locale = toLocale(params.locale);

  const categorySlug = url.searchParams.get("category")?.trim() || null;
  const tagSlug = url.searchParams.get("tag")?.trim() || null;
  const q = url.searchParams.get("q")?.trim() || null;

  // Resolve slugs → IDs (categories/tags lists are small; in-memory scan is fine).
  const [categories, tags] = await Promise.all([
    locals.content.listCategories(),
    locals.content.listTags(),
  ]);

  const activeCategory = categorySlug
    ? (categories.find((c) => c.slug === categorySlug) ?? null)
    : null;
  const activeTag = tagSlug
    ? (tags.find((t) => t.slug === tagSlug) ?? null)
    : null;

  // Search and filter are independent surfaces:
  //   - With ?q=, we run FTS5 and ignore category/tag filters (the
  //     search ordering is BM25-based; mixing in filters would be
  //     surprising). Matched articles are then hydrated to the
  //     same ArticleRecord shape the index expects.
  //   - Without ?q=, the existing list/filter path runs unchanged.
  let articles;
  let searchHits = null;

  if (q) {
    searchHits = await locals.content.searchArticles(q, {
      locale,
      onlyPublished: true,
      onlyPublishedStatus: true,
      limit: 30,
    });

    // Hydrate matched articles to ArticleRecord. Order by FTS rank
    // (already returned by searchArticles), de-duped by article id
    // since one article can match in multiple locales.
    const seenIds = new Set<string>();
    const orderedIds: string[] = [];
    for (const hit of searchHits) {
      if (seenIds.has(hit.articleId)) continue;
      seenIds.add(hit.articleId);
      orderedIds.push(hit.articleId);
    }
    const fullArticles = await Promise.all(
      orderedIds.map((id) => locals.content.getArticle(id)),
    );
    const items = fullArticles.filter((a): a is NonNullable<typeof a> =>
      Boolean(a),
    );
    articles = { items, total: items.length, page: 1, limit: items.length };
  } else {
    articles = await locals.content.listArticles({
      status: "published",
      onlyPublished: true,
      locale,
      page: 1,
      limit: 20,
      ...(activeCategory ? { categoryId: activeCategory.id } : {}),
      ...(activeTag ? { tagId: activeTag.id } : {}),
    });
  }

  // SEO: index page. If a search query is present we ask robots not
  // to index the no-result-friendly variant (?q=…) — only the bare
  // /blog should be a canonical search target.
  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);
  const blogPath = activeCategory
    ? `/${locale}/blog?category=${activeCategory.slug}`
    : activeTag
      ? `/${locale}/blog?tag=${activeTag.slug}`
      : `/${locale}/blog`;
  const canonical = canonicalUrl(origin, blogPath);
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    alternates[l] = canonicalUrl(origin, `/${l}/blog`);
  }

  const filterLabel =
    activeCategory?.localizations[locale]?.name ??
    activeCategory?.slug ??
    activeTag?.localizations[locale]?.name ??
    activeTag?.slug ??
    null;

  const seo: PageSeo = {
    title: filterLabel
      ? `${filterLabel} — ${settings?.siteName ?? "Khao Pad"}`
      : `${settings?.siteName ?? "Khao Pad"} — Blog`,
    description: filterLabel
      ? `Articles tagged ${filterLabel}.`
      : "Latest articles.",
    canonical,
    locale,
    alternates,
    ogType: "website",
    robots: q ? "noindex,follow" : undefined,
  };

  return {
    locale,
    articles,
    categories,
    tags,
    activeCategory,
    activeTag,
    q,
    searchHits,
    seo,
  };
};
