import { error, fail, redirect } from "@sveltejs/kit";
import {
  canDeleteArticle,
  canEditArticle,
  canPublish,
} from "$lib/server/auth/permissions";
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
  save: async ({ request, locals, params }) => {
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

    const update: ArticleUpdateInput = {
      status: nextStatus,
      coverMediaId: coverMediaId ? coverMediaId : null,
      categoryId: categoryId ? categoryId : null,
      tagIds,
      publishedAt:
        nextStatus === "published"
          ? (existing.publishedAt ?? new Date().toISOString())
          : nextStatus === "draft"
            ? null
            : existing.publishedAt,
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
    return { ok: true };
  },

  togglePublish: async ({ locals, params }) => {
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
    return { ok: true, status: next };
  },

  delete: async ({ locals, params }) => {
    const user = requireAuthor(locals);
    const existing = await locals.content.getArticle(params.id);
    if (!existing) return fail(404, { error: "Article not found" });
    if (!canDeleteArticle(user, existing.authorId)) {
      return fail(403, { error: "You are not allowed to delete this article" });
    }
    await locals.content.deleteArticle(params.id);
    throw redirect(303, "/cms/articles");
  },
};
