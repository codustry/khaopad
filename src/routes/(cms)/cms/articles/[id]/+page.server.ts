import { error, fail, redirect } from "@sveltejs/kit";
import {
  canDeleteArticle,
  canEditArticle,
  canPublish,
} from "$lib/server/auth/permissions";
import { logAudit, type AuditAction } from "$lib/server/audit";
import { AnalyticsService } from "$lib/server/analytics";
import { slugify } from "$lib/utils";
import { SUPPORTED_LOCALES } from "$lib/i18n";
import type { ArticleUpdateInput } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, platform }) => {
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

  // v1.8: 30-day sparkline of public views for this article. Sums
  // across every locale path (/{locale}/blog/{slug}) so the editor
  // sees one number per day, not two.
  let sparkline: Array<{ date: string; count: number }> = [];
  let totalViews = 0;
  if (platform?.env?.DB) {
    try {
      const analytics = new AnalyticsService(platform.env.DB);
      const series = await Promise.all(
        SUPPORTED_LOCALES.map((l) =>
          analytics.sparkline(`/${l}/blog/${article.slug}`, 30),
        ),
      );
      // Merge: same date keys across locales, sum counts.
      const merged = new Map<string, number>();
      for (const s of series) {
        for (const p of s) {
          merged.set(p.date, (merged.get(p.date) ?? 0) + p.count);
        }
      }
      sparkline = [...merged.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
      totalViews = sparkline.reduce((s, p) => s + p.count, 0);
    } catch {
      // best-effort
    }
  }

  return { article, categories, tags, sparkline, totalViews };
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
    const seoTitleEn = String(form.get("seo_title_en") ?? "").trim();
    const seoDescriptionEn = String(form.get("seo_description_en") ?? "").trim();
    const titleTh = String(form.get("title_th") ?? "").trim();
    const excerptTh = String(form.get("excerpt_th") ?? "").trim();
    const bodyTh = String(form.get("body_th") ?? "");
    const seoTitleTh = String(form.get("seo_title_th") ?? "").trim();
    const seoDescriptionTh = String(form.get("seo_description_th") ?? "").trim();
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
    const commentsModeRaw = String(form.get("comments_mode") ?? "inherit");
    const commentsMode = (
      ["inherit", "on", "off"].includes(commentsModeRaw)
        ? commentsModeRaw
        : "inherit"
    ) as "inherit" | "on" | "off";

    if (!titleEn || !bodyEn) {
      return fail(400, {
        error: "English title and body are required.",
        values: {
          titleEn,
          excerptEn,
          bodyEn,
          seoTitleEn,
          seoDescriptionEn,
          titleTh,
          excerptTh,
          bodyTh,
          seoTitleTh,
          seoDescriptionTh,
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
      commentsMode,
      actorId: user.id,
      localizations: {
        en: {
          title: titleEn,
          excerpt: excerptEn,
          body: bodyEn,
          seoTitle: seoTitleEn || undefined,
          seoDescription: seoDescriptionEn || undefined,
        },
        ...(titleTh && bodyTh
          ? {
              th: {
                title: titleTh,
                excerpt: excerptTh,
                body: bodyTh,
                seoTitle: seoTitleTh || undefined,
                seoDescription: seoDescriptionTh || undefined,
              },
            }
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
          seoTitleEn,
          seoDescriptionEn,
          titleTh,
          excerptTh,
          bodyTh,
          seoTitleTh,
          seoDescriptionTh,
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
