import { fail, redirect } from "@sveltejs/kit";
import { canDeleteArticle } from "$lib/server/auth/permissions";
import { byString, parseSort, sortRows } from "$lib/server/admin/sort";
import type { ArticleFilter, ArticleRecord } from "$lib/server/content/types";
import type { PageServerLoad, Actions } from "./$types";

const STATUSES: ArticleRecord["status"][] = ["draft", "published", "archived"];

/** Sortable columns (#160 C5). `sort` never reaches SQL — it only
 * selects one of these literal comparators over the loaded page. */
const SORTABLE = ["title", "status", "updated"] as const;

const COMPARATORS = {
  title: byString<ArticleRecord>(
    (a) => a.localizations.en?.title ?? a.localizations.th?.title ?? a.slug,
  ),
  status: byString<ArticleRecord>((a) => a.status),
  // ISO strings compare lexically in date order.
  updated: byString<ArticleRecord>((a) => a.updatedAt),
};

export const load: PageServerLoad = async ({ locals, url }) => {
  const statusParam = url.searchParams.get("status");
  const filter: ArticleFilter = { page: 1, limit: 50 };
  if (
    statusParam &&
    STATUSES.includes(statusParam as ArticleRecord["status"])
  ) {
    filter.status = statusParam as ArticleRecord["status"];
  }

  // Trimmed, because a search of only spaces would otherwise LIKE-match
  // every title containing a space — i.e. all of them — while looking to
  // the user like a filter that silently failed.
  const search = url.searchParams.get("q")?.trim();
  if (search) filter.search = search;

  const articles = await locals.content.listArticles(filter);

  // In-memory sort over the loaded page (50 rows) — the provider has
  // no orderBy seam yet; see $lib/server/admin/sort.
  const { sort, dir } = parseSort(url, SORTABLE);
  articles.items = sortRows(articles.items, COMPARATORS, sort, dir);

  return {
    articles,
    status: filter.status ?? null,
    search: search ?? "",
    sort,
    dir,
  };
};

export const actions: Actions = {
  delete: async ({ request, locals }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    const form = await request.formData();
    const id = String(form.get("id") ?? "");
    if (!id) return fail(400, { error: "Missing article id" });

    const article = await locals.content.getArticle(id);
    if (!article) return fail(404, { error: "Article not found" });

    if (!canDeleteArticle(locals.user, article.authorId)) {
      return fail(403, { error: "You are not allowed to delete this article" });
    }

    await locals.content.deleteArticle(id);
    return { ok: true };
  },
};
