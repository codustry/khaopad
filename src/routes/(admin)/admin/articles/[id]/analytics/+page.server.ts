/**
 * /admin/articles/[id]/analytics — per-article dashboard.
 *
 * Editor+ can view. Shows article_read count, median read time,
 * scroll depth distribution, attributed purchases, top referrers.
 * All numbers scoped to a 30-day window; longer windows would
 * benefit from a rollup table (deferred).
 */
import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { getArticleAnalytics } from "$lib/server/analytics/aggregate";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw error(
      403,
      "Only editors, admins and super admins can access this area.",
    );
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const article = await locals.content.getArticle(params.id);
  if (!article) throw error(404, "Article not found");
  const analytics = await getArticleAnalytics(env.DB, params.id, 30);
  const enTitle = article.localizations?.en?.title ?? article.slug ?? params.id;
  return { articleId: params.id, articleTitle: enTitle, analytics };
};
