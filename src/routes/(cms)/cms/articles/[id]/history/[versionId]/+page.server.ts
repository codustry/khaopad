import { error, fail, redirect } from "@sveltejs/kit";
import { canEditArticle } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { diffLines } from "$lib/server/content/diff";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  const article = await locals.content.getArticle(params.id);
  if (!article) throw error(404, "Article not found");
  if (!canEditArticle(locals.user, article.authorId)) {
    throw error(403, "You're not allowed to view this article's history.");
  }

  const version = await locals.content.getArticleVersion(params.versionId);
  if (!version || version.articleId !== params.id) {
    throw error(404, "Version not found");
  }

  // Compare the snapshot against the current live row in the same locale.
  const live = article.localizations[version.locale] ?? {
    title: "",
    excerpt: "",
    body: "",
  };

  return {
    article,
    version,
    diff: {
      title: { before: version.title, after: live.title },
      excerpt: {
        before: version.excerpt ?? "",
        after: live.excerpt ?? "",
      },
      body: diffLines(version.body, live.body),
    },
  };
};

export const actions: Actions = {
  /**
   * Restore the snapshot's content into the live article row, then
   * snapshot the result (via the existing updateArticle write hook
   * which calls snapshotVersion). Net effect: a new "vN+1" appears in
   * history with the restored content.
   */
  restore: async ({ locals, params, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    const article = await locals.content.getArticle(params.id);
    if (!article) throw error(404, "Article not found");
    if (!canEditArticle(locals.user, article.authorId)) {
      return fail(403, {
        error: "You're not allowed to restore this version.",
      });
    }

    const version = await locals.content.getArticleVersion(params.versionId);
    if (!version || version.articleId !== params.id) {
      return fail(404, { error: "Version not found." });
    }

    await locals.content.updateArticle(params.id, {
      actorId: locals.user.id,
      localizations: {
        [version.locale]: {
          title: version.title,
          excerpt: version.excerpt ?? "",
          body: version.body,
          seoTitle: version.seoTitle ?? undefined,
          seoDescription: version.seoDescription ?? undefined,
        },
      },
    });

    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "article.update",
        params.id,
        {
          slug: article.slug,
          restoredFrom: version.id,
          restoredVersion: version.version,
          locale: version.locale,
        },
      );
    }

    throw redirect(303, `/cms/articles/${params.id}`);
  },
};
