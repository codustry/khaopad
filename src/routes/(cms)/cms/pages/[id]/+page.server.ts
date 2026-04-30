import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { slugify } from "$lib/utils";
import type { PageUpdateInput } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage pages.");
  }
  const page = await locals.content.getPage(params.id);
  if (!page) throw error(404, "Page not found");
  return { page };
};

export const actions: Actions = {
  save: async ({ request, locals, params, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const existing = await locals.content.getPage(params.id);
    if (!existing) return fail(404, { error: "Page not found" });

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

    const explicitPublishedAt = publishedAtLocal
      ? new Date(publishedAtLocal).toISOString()
      : null;
    const resolvedPublishedAt =
      status === "draft"
        ? null
        : (explicitPublishedAt ??
          existing.publishedAt ??
          new Date().toISOString());

    const update: PageUpdateInput = {
      template,
      status,
      publishedAt: resolvedPublishedAt,
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
    };
    if (slugInput && slugify(slugInput) !== existing.slug) {
      update.slug = slugInput;
    }

    try {
      await locals.content.updatePage(params.id, update);
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to save page",
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

    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        params.id,
        {
          kind: "page.update",
          slug: existing.slug,
          from: existing.status,
          to: status,
        },
      );
    }
    return { ok: true };
  },

  delete: async ({ locals, params, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const existing = await locals.content.getPage(params.id);
    if (!existing) return fail(404, { error: "Page not found" });
    await locals.content.deletePage(params.id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        params.id,
        { kind: "page.delete", slug: existing.slug },
      );
    }
    throw redirect(303, "/cms/pages");
  },
};
