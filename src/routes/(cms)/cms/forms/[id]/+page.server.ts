import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { isValidFieldList } from "$lib/server/forms";
import { slugify } from "$lib/utils";
import type { FormSubmissionStatus } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

const SUBMISSION_LIMIT = 100;

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage forms.");
  }
  const form = await locals.content.getForm(params.id);
  if (!form) throw error(404, "Form not found");
  const submissions = await locals.content.listFormSubmissions(form.id, {
    limit: SUBMISSION_LIMIT,
  });
  return { form, submissions };
};

export const actions: Actions = {
  save: async ({ request, locals, params, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const existing = await locals.content.getForm(params.id);
    if (!existing) return fail(404, { error: "Form not found" });

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

    if (key !== existing.key) {
      const conflict = await locals.content.getFormByKey(key);
      if (conflict) {
        return fail(400, { error: `Key "${key}" is already taken.` });
      }
    }

    await locals.content.updateForm(params.id, {
      key,
      label,
      fields,
      enabled,
      successMessages: {
        ...(successEn ? { en: successEn } : {}),
        ...(successTh ? { th: successTh } : {}),
      },
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "form.update",
        params.id,
        { key, label },
      );
    }
    return { ok: true };
  },

  delete: async ({ locals, params, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const existing = await locals.content.getForm(params.id);
    if (!existing) return fail(404, { error: "Form not found" });
    await locals.content.deleteForm(params.id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "form.delete",
        params.id,
        { key: existing.key },
      );
    }
    throw redirect(303, "/cms/forms");
  },

  /** Update a single submission's status (e.g. "spam" or "archived"). */
  setSubmissionStatus: async ({ request, locals, params }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const fd = await request.formData();
    const submissionId = String(fd.get("submission_id") ?? "").trim();
    const status = String(fd.get("status") ?? "") as FormSubmissionStatus;
    if (!submissionId || !["new", "read", "spam", "archived"].includes(status)) {
      return fail(400, { error: "Bad request" });
    }
    // Confirm this submission belongs to the form on this page (defense
    // in depth; the URL is admin-only but routing typos shouldn't poke
    // a different form's row).
    const submission = await locals.content.getFormSubmission(submissionId);
    if (!submission || submission.formId !== params.id) {
      return fail(404, { error: "Submission not found" });
    }
    await locals.content.updateFormSubmission(submissionId, { status });
    return { ok: true };
  },

  deleteSubmission: async ({ request, locals, params }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const fd = await request.formData();
    const submissionId = String(fd.get("submission_id") ?? "").trim();
    if (!submissionId) return fail(400, { error: "Missing id" });
    const submission = await locals.content.getFormSubmission(submissionId);
    if (!submission || submission.formId !== params.id) {
      return fail(404, { error: "Submission not found" });
    }
    await locals.content.deleteFormSubmission(submissionId);
    return { ok: true };
  },
};
