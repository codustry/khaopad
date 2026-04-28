import { error, fail, redirect } from "@sveltejs/kit";
import {
  canDeleteArticle,
  canEditArticle,
  canPublish,
} from "$lib/server/auth/permissions";
import { logAudit, type AuditAction } from "$lib/server/audit";
import { slugify } from "$lib/utils";
import type { ArticleUpdateInput } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  const article = await locals.content.getArticle(params.id);
  if (!article) throw error(404, "Article not found");
  if (!canEditArticle(locals.user, article.authorId)) {
    throw error(403, "You are not allowed to edit this article");
  }
  const [categories, tags] = await Promise.all([
    locals.content.listCategories(),
    locals.content.listTags(),
  ]);
  return { article, categories, tags };
};

function requireAuthor(locals: App.Locals) {
  if (!locals.user) throw redirect(302, "/cms/login");
  return locals.user;
}

export const actions: Actions = {
  save: async ({ request, locals, params, platform }) => {
    const user = requireAuthor(locals);
    const existing = await locals.content.getArticle(params.id);
    if (!existing) return fail(404, { error: "Article not found" });
    if (!canEditArticle(user, existing.authorId)) {
      return fail(403, { error: "Forbidden" });
    }

    const form = await request.formData();
    const titleEn = String(form.get("title_en") ?? "").trim();
    const excerptEn = String(form.get("excerpt_en") ?? "").trim();
    const bodyEn = String(form.get("body_en") ?? "");
    const titleTh = String(form.get("title_th") ?? "").trim();
    const excerptTh = String(form.get("excerpt_th") ?? "").trim();
    const bodyTh = String(form.get("body_th") ?? "");
    const slugInput = String(form.get("slug") ?? "").trim();
    const coverMediaId = String(form.get("cover_media_id") ?? "").trim();
    const categoryId = String(form.get("category_id") ?? "").trim();
    const tagIds = form
      .getAll("tag_ids")
      .map((v) => String(v).trim())
      .filter(Boolean);
    const nextStatus = String(form.get("status") ?? existing.status) as
      | "draft"
      | "published"
      | "archived";
    const publishedAtLocal = String(
      form.get("published_at_local") ?? "",
    ).trim();

    if (!titleEn || !bodyEn) {
      return fail(400, {
        error: "English title and body are required.",
        values: {
          titleEn,
          excerptEn,
          bodyEn,
          titleTh,
          excerptTh,
          bodyTh,
          slugInput,
          status: nextStatus,
          coverMediaId,
          categoryId,
          tagIds,
        },
      });
    }

    if (
      nextStatus !== existing.status &&
      !canPublish(user) &&
      user.id !== existing.authorId
    ) {
      return fail(403, {
        error: "Only editors+ can change status on others' articles",
      });
    }

    // publishedAt resolution:
    //   - explicit datetime from form (treated as local, stored as ISO) wins
    //     when status is published/archived
    //   - draft always clears publishedAt
    //   - published with no form value falls back to existing or now()
    //   - archived keeps the existing value
    const explicitPublishedAt = publishedAtLocal
      ? new Date(publishedAtLocal).toISOString()
      : null;
    const resolvedPublishedAt =
      nextStatus === "draft"
        ? null
        : nextStatus === "published"
          ? (explicitPublishedAt ??
            existing.publishedAt ??
            new Date().toISOString())
          : (explicitPublishedAt ?? existing.publishedAt);

    const update: ArticleUpdateInput = {
      status: nextStatus,
      coverMediaId: coverMediaId ? coverMediaId : null,
      categoryId: categoryId ? categoryId : null,
      tagIds,
      publishedAt: resolvedPublishedAt,
      localizations: {
        en: { title: titleEn, excerpt: excerptEn, body: bodyEn },
        ...(titleTh && bodyTh
          ? { th: { title: titleTh, excerpt: excerptTh, body: bodyTh } }
          : {}),
      },
    };
    if (slugInput && slugify(slugInput) !== existing.slug) {
      update.slug = slugInput;
    }

    try {
      await locals.content.updateArticle(params.id, update);
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to save",
        values: {
          titleEn,
          excerptEn,
          bodyEn,
          titleTh,
          excerptTh,
          bodyTh,
          slugInput,
          status: nextStatus,
          coverMediaId,
          categoryId,
          tagIds,
        },
      });
    }

    // Audit: log a publish/unpublish event when status changed, plus a
    // generic update event for any save. Both rows make the timeline
    // useful when debugging "who published this and when?".
    if (platform?.env?.DB) {
      const actions: AuditAction[] = ["article.update"];
      if (existing.status !== nextStatus) {
        if (nextStatus === "published") actions.push("article.publish");
        else if (existing.status === "published")
          actions.push("article.unpublish");
      }
      for (const action of actions) {
        await logAudit(platform.env.DB, user.id, action, params.id, {
          slug: existing.slug,
          from: existing.status,
          to: nextStatus,
        });
      }
    }
    return { ok: true };
  },

  togglePublish: async ({ locals, params, platform }) => {
    const user = requireAuthor(locals);
    const existing = await locals.content.getArticle(params.id);
    if (!existing) return fail(404, { error: "Article not found" });
    if (!canEditArticle(user, existing.authorId)) {
      return fail(403, { error: "Forbidden" });
    }
    if (!canPublish(user) && user.id !== existing.authorId) {
      return fail(403, { error: "Only editors+ can publish others' articles" });
    }

    const next = existing.status === "published" ? "draft" : "published";
    await locals.content.updateArticle(params.id, {
      status: next,
      publishedAt:
        next === "published"
          ? (existing.publishedAt ?? new Date().toISOString())
          : null,
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        user.id,
        next === "published" ? "article.publish" : "article.unpublish",
        params.id,
        { slug: existing.slug },
      );
    }
    return { ok: true, status: next };
  },

  delete: async ({ locals, params, platform }) => {
    const user = requireAuthor(locals);
    const existing = await locals.content.getArticle(params.id);
    if (!existing) return fail(404, { error: "Article not found" });
    if (!canDeleteArticle(user, existing.authorId)) {
      return fail(403, {
        error: "You are not allowed to delete this article",
      });
    }
    await locals.content.deleteArticle(params.id);
    if (platform?.env?.DB) {
      await logAudit(platform.env.DB, user.id, "article.delete", params.id, {
        slug: existing.slug,
      });
    }
    throw redirect(303, "/cms/articles");
  },
};
