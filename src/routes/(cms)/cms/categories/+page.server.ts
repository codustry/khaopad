import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { slugify } from "$lib/utils";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  const items = await locals.content.listCategories();
  return { items };
};

function requireTaxonomyManager(locals: App.Locals) {
  if (!locals.user) throw error(401, "Not authenticated");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Only editors+ can manage categories");
  }
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requireTaxonomyManager(locals);
    const form = await request.formData();
    const nameEn = String(form.get("name_en") ?? "").trim();
    const nameTh = String(form.get("name_th") ?? "").trim();
    const descEn = String(form.get("description_en") ?? "").trim();
    const descTh = String(form.get("description_th") ?? "").trim();
    const slugInput = String(form.get("slug") ?? "").trim();

    if (!nameEn) {
      return fail(400, {
        error: "English name is required.",
        values: { nameEn, nameTh, descEn, descTh, slugInput },
      });
    }

    const slug = slugify(slugInput || nameEn);
    if (!slug) {
      return fail(400, {
        error:
          "Slug could not be derived — provide an English name or explicit ASCII slug.",
        values: { nameEn, nameTh, descEn, descTh, slugInput },
      });
    }

    try {
      await locals.content.createCategory({
        slug,
        localizations: {
          en: { name: nameEn, description: descEn || undefined },
          ...(nameTh
            ? { th: { name: nameTh, description: descTh || undefined } }
            : {}),
        },
      });
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to create category",
        values: { nameEn, nameTh, descEn, descTh, slugInput },
      });
    }
    return { ok: true };
  },

  update: async ({ request, locals }) => {
    requireTaxonomyManager(locals);
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });

    const nameEn = String(form.get("name_en") ?? "").trim();
    const nameTh = String(form.get("name_th") ?? "").trim();
    const descEn = String(form.get("description_en") ?? "").trim();
    const descTh = String(form.get("description_th") ?? "").trim();
    const slugInput = String(form.get("slug") ?? "").trim();

    if (!nameEn) return fail(400, { error: "English name is required." });

    try {
      await locals.content.updateCategory(id, {
        slug: slugInput ? slugify(slugInput) : undefined,
        localizations: {
          en: { name: nameEn, description: descEn || undefined },
          ...(nameTh
            ? { th: { name: nameTh, description: descTh || undefined } }
            : {}),
        },
      });
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to update",
      });
    }
    return { ok: true };
  },

  delete: async ({ request, locals }) => {
    requireTaxonomyManager(locals);
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });
    await locals.content.deleteCategory(id);
    return { ok: true };
  },
};
