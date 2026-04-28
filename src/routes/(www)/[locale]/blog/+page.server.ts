import { toLocale } from "$lib/i18n";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const locale = toLocale(params.locale);

  const categorySlug = url.searchParams.get("category")?.trim() || null;
  const tagSlug = url.searchParams.get("tag")?.trim() || null;

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

  const articles = await locals.content.listArticles({
    status: "published",
    onlyPublished: true,
    locale,
    page: 1,
    limit: 20,
    ...(activeCategory ? { categoryId: activeCategory.id } : {}),
    ...(activeTag ? { tagId: activeTag.id } : {}),
  });

  return {
    locale,
    articles,
    categories,
    tags,
    activeCategory,
    activeTag,
  };
};
