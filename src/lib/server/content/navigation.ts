import type {
  ContentProvider,
  Locale,
  NavigationItemRecord,
  NavigationMenuRecord,
} from "./types";

/**
 * Resolve a `NavigationItemRecord`'s target into a public URL for
 * the given locale. Pure function — does no I/O. Caller must already
 * have the article/page/category/tag slugs handy if it wants nice
 * URLs; we accept lookup maps so the caller does it once per request.
 */
export function navItemHref(
  item: NavigationItemRecord,
  locale: Locale,
  lookup: {
    pageSlugById: Map<string, string>;
    articleSlugById: Map<string, string>;
    categorySlugById: Map<string, string>;
    tagSlugById: Map<string, string>;
  },
): string {
  switch (item.kind) {
    case "custom":
      return item.customUrl ?? "#";
    case "page": {
      const slug = item.targetId
        ? lookup.pageSlugById.get(item.targetId)
        : undefined;
      return slug ? `/${locale}/${slug}` : "#";
    }
    case "article": {
      const slug = item.targetId
        ? lookup.articleSlugById.get(item.targetId)
        : undefined;
      return slug ? `/${locale}/blog/${slug}` : "#";
    }
    case "category": {
      const slug = item.targetId
        ? lookup.categorySlugById.get(item.targetId)
        : undefined;
      return slug ? `/${locale}/blog?category=${slug}` : "#";
    }
    case "tag": {
      const slug = item.targetId
        ? lookup.tagSlugById.get(item.targetId)
        : undefined;
      return slug ? `/${locale}/blog?tag=${slug}` : "#";
    }
  }
}

/**
 * Pre-fetch the menus needed by the public layout, plus the slug
 * lookup tables a renderer needs to turn `NavigationItemRecord` →
 * URL. Single helper so loaders don't repeat themselves. Best-effort
 * (errors return empty data so a misconfigured site still serves
 * pages).
 */
export async function loadNavigation(
  content: ContentProvider,
  keys: string[],
): Promise<{
  menus: Record<string, NavigationMenuRecord | null>;
  pageSlugById: Map<string, string>;
  articleSlugById: Map<string, string>;
  categorySlugById: Map<string, string>;
  tagSlugById: Map<string, string>;
}> {
  try {
    const allMenus = await content.listMenus();
    const menus: Record<string, NavigationMenuRecord | null> = {};
    for (const k of keys) {
      menus[k] = allMenus.find((m) => m.key === k) ?? null;
    }

    // Build slug lookups from the published surface only.
    const [pages, articleResult, categories, tags] = await Promise.all([
      content.listPages({ status: "published", onlyPublished: true }),
      content.listArticles({
        status: "published",
        onlyPublished: true,
        limit: 200,
      }),
      content.listCategories(),
      content.listTags(),
    ]);

    return {
      menus,
      pageSlugById: new Map(pages.map((p) => [p.id, p.slug])),
      articleSlugById: new Map(
        articleResult.items.map((a) => [a.id, a.slug]),
      ),
      categorySlugById: new Map(categories.map((c) => [c.id, c.slug])),
      tagSlugById: new Map(tags.map((t) => [t.id, t.slug])),
    };
  } catch {
    return {
      menus: {},
      pageSlugById: new Map(),
      articleSlugById: new Map(),
      categorySlugById: new Map(),
      tagSlugById: new Map(),
    };
  }
}
