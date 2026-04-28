import { fail, redirect } from "@sveltejs/kit";
import { generateSlugFromTitle, slugify } from "$lib/utils";
import { logAudit } from "$lib/server/audit";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  const [categories, tags] = await Promise.all([
    locals.content.listCategories(),
    locals.content.listTags(),
  ]);
  return { categories, tags };
};

export const actions: Actions = {
  default: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");

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
    const status = String(form.get("status") ?? "draft") as
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
          status,
          coverMediaId,
          categoryId,
          tagIds,
        },
      });
    }

    let slug: string;
    try {
      slug = slugInput ? slugify(slugInput) : generateSlugFromTitle(titleEn);
      if (!slug) throw new Error("Empty slug");
    } catch {
      return fail(400, {
        error: "Slug could not be derived — provide an explicit ASCII slug.",
        values: {
          titleEn,
          excerptEn,
          bodyEn,
          titleTh,
          excerptTh,
          bodyTh,
          slugInput,
          status,
          coverMediaId,
          categoryId,
          tagIds,
        },
      });
    }

    // publishedAt resolution:
    //   - explicit datetime from the form wins (treated as local time, stored as ISO)
    //   - otherwise: published → now(), draft/archived → null
    const publishedAt = publishedAtLocal
      ? new Date(publishedAtLocal).toISOString()
      : status === "published"
        ? new Date().toISOString()
        : undefined;

    try {
      const article = await locals.content.createArticle({
        slug,
        authorId: locals.user.id,
        actorId: locals.user.id,
        status,
        coverMediaId: coverMediaId || undefined,
        categoryId: categoryId || undefined,
        tagIds: tagIds.length ? tagIds : undefined,
        publishedAt,
        localizations: {
          en: { title: titleEn, excerpt: excerptEn, body: bodyEn },
          ...(titleTh && bodyTh
            ? { th: { title: titleTh, excerpt: excerptTh, body: bodyTh } }
            : {}),
        },
      });
      if (platform?.env?.DB) {
        await logAudit(
          platform.env.DB,
          locals.user.id,
          "article.create",
          article.id,
          { slug: article.slug, status: article.status },
        );
      }
      throw redirect(303, `/cms/articles/${article.id}`);
    } catch (err) {
      if (err instanceof Response) throw err; // let redirect through
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to create article",
        values: {
          titleEn,
          excerptEn,
          bodyEn,
          titleTh,
          excerptTh,
          bodyTh,
          slugInput,
          status,
          coverMediaId,
          categoryId,
          tagIds,
        },
      });
    }
  },
};
