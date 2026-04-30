import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { generateSlugFromTitle, slugify } from "$lib/utils";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage pages.");
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const form = await request.formData();
    const titleEn = String(form.get("title_en") ?? "").trim();
    const bodyEn = String(form.get("body_en") ?? "");
    const seoTitleEn = String(form.get("seo_title_en") ?? "").trim();
    const seoDescriptionEn = String(form.get("seo_description_en") ?? "").trim();
    const titleTh = String(form.get("title_th") ?? "").trim();
    const bodyTh = String(form.get("body_th") ?? "");
    const seoTitleTh = String(form.get("seo_title_th") ?? "").trim();
    const seoDescriptionTh = String(form.get("seo_description_th") ?? "").trim();
    const slugInput = String(form.get("slug") ?? "").trim();
    const template = (String(form.get("template") ?? "default") as
      | "default"
      | "landing"
      | "legal");
    const status = (String(form.get("status") ?? "draft") as
      | "draft"
      | "published");
    const publishedAtLocal = String(
      form.get("published_at_local") ?? "",
    ).trim();

    if (!titleEn || !bodyEn) {
      return fail(400, {
        error: "English title and body are required.",
        values: {
          titleEn,
          bodyEn,
          seoTitleEn,
          seoDescriptionEn,
          titleTh,
          bodyTh,
          seoTitleTh,
          seoDescriptionTh,
          slugInput,
          template,
          status,
          publishedAtLocal,
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
          bodyEn,
          seoTitleEn,
          seoDescriptionEn,
          titleTh,
          bodyTh,
          seoTitleTh,
          seoDescriptionTh,
          slugInput,
          template,
          status,
          publishedAtLocal,
        },
      });
    }

    const publishedAt = publishedAtLocal
      ? new Date(publishedAtLocal).toISOString()
      : status === "published"
        ? new Date().toISOString()
        : null;

    try {
      const page = await locals.content.createPage({
        slug,
        template,
        status,
        publishedAt,
        authorId: locals.user.id,
        localizations: {
          en: {
            title: titleEn,
            body: bodyEn,
            seoTitle: seoTitleEn || undefined,
            seoDescription: seoDescriptionEn || undefined,
          },
          ...(titleTh && bodyTh
            ? {
                th: {
                  title: titleTh,
                  body: bodyTh,
                  seoTitle: seoTitleTh || undefined,
                  seoDescription: seoDescriptionTh || undefined,
                },
              }
            : {}),
        },
      });
      if (platform?.env?.DB) {
        await logAudit(
          platform.env.DB,
          locals.user.id,
          "settings.update",
          page.id,
          { kind: "page.create", slug: page.slug, status: page.status },
        );
      }
      throw redirect(303, `/cms/pages/${page.id}`);
    } catch (err) {
      if (err instanceof Response) throw err;
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to create page",
        values: {
          titleEn,
          bodyEn,
          seoTitleEn,
          seoDescriptionEn,
          titleTh,
          bodyTh,
          seoTitleTh,
          seoDescriptionTh,
          slugInput,
          template,
          status,
          publishedAtLocal,
        },
      });
    }
  },
};
