import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { isValidFieldList } from "$lib/server/forms";
import { slugify } from "$lib/utils";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage forms.");
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const fd = await request.formData();
    const label = String(fd.get("label") ?? "").trim();
    const keyRaw = String(fd.get("key") ?? "").trim();
    const enabled = fd.get("enabled") === "on";
    const fieldsRaw = String(fd.get("fields") ?? "");
    const successEn = String(fd.get("success_en") ?? "").trim();
    const successTh = String(fd.get("success_th") ?? "").trim();

    const key = slugify(keyRaw || label);
    if (!key || !label) {
      return fail(400, { error: "Key and label are required." });
    }

    let fields: ReturnType<typeof JSON.parse>;
    try {
      fields = JSON.parse(fieldsRaw);
    } catch {
      return fail(400, { error: "Field definitions must be valid JSON." });
    }
    if (!isValidFieldList(fields)) {
      return fail(400, { error: "Field definitions are malformed." });
    }

    const existing = await locals.content.getFormByKey(key);
    if (existing) {
      return fail(400, { error: `A form with key "${key}" already exists.` });
    }

    const form = await locals.content.createForm({
      key,
      label,
      fields,
      enabled,
      successMessages: {
        ...(successEn ? { en: successEn } : {}),
        ...(successTh ? { th: successTh } : {}),
      },
      createdBy: locals.user.id,
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "form.create",
        form.id,
        { key: form.key, label: form.label },
      );
    }
    throw redirect(303, `/cms/forms/${form.id}`);
  },
};
