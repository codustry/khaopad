import { fail, redirect } from "@sveltejs/kit";
import { canDeleteArticle } from "$lib/server/auth/permissions";
import type { ArticleFilter, ArticleRecord } from "$lib/server/content/types";
import type { PageServerLoad, Actions } from "./$types";

const STATUSES: ArticleRecord["status"][] = ["draft", "published", "archived"];

export const load: PageServerLoad = async ({ locals, url }) => {
  const statusParam = url.searchParams.get("status");
  const filter: ArticleFilter = { page: 1, limit: 50 };
  if (
    statusParam &&
    STATUSES.includes(statusParam as ArticleRecord["status"])
  ) {
    filter.status = statusParam as ArticleRecord["status"];
  }
  const articles = await locals.content.listArticles(filter);
  return { articles, status: filter.status ?? null };
};

export const actions: Actions = {
  delete: async ({ request, locals }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
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
