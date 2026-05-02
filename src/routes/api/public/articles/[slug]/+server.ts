import { error, json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import type { RequestHandler } from "./$types";

/**
 * GET /api/public/articles/[slug]
 *
 * Single-article fetch by slug. Drafts and future-dated published
 * articles 404 — consumers never see unpublished content.
 */
export const GET: RequestHandler = async ({ request, params, locals }) => {
  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, "articles:read")) {
    return json({ error: "Forbidden — articles:read scope required" }, { status: 403 });
  }

  const article = await locals.content.getArticleBySlug(params.slug);
  if (!article) throw error(404, "Article not found");
  if (article.status !== "published") throw error(404, "Article not found");
  if (article.publishedAt && new Date(article.publishedAt) > new Date()) {
    throw error(404, "Article not found");
  }

  return json(
    {
      id: article.id,
      slug: article.slug,
      publishedAt: article.publishedAt,
      updatedAt: article.updatedAt,
      coverMediaId: article.coverMediaId,
      categoryId: article.categoryId,
      tagIds: article.tagIds,
      commentsMode: article.commentsMode,
      localizations: article.localizations,
    },
    { headers: { "cache-control": "public, max-age=120" } },
  );
};
