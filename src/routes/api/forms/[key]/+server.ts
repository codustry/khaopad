import { error, json } from "@sveltejs/kit";
import {
  HONEYPOT_FIELD,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_SECONDS,
  hashIp,
  validateSubmission,
} from "$lib/server/forms";
import { logAudit } from "$lib/server/audit";
import { dispatchEvent } from "$lib/server/webhooks";
import type { RequestHandler } from "./$types";

/**
 * POST /api/forms/[key]
 *
 * Public form submission endpoint (v2.0a). Accepts multipart/form-data
 * or url-encoded; reads the form definition by key and validates the
 * payload. Implements the v2.0 floor for spam defenses: a honeypot
 * field (`_hp`) and a per-IP-hash rate limit (3 submissions per minute
 * per form). No CAPTCHA.
 *
 * Returns:
 *   201 + { id, message } on success
 *   400 on validation error (including honeypot + rate limit)
 *   404 when the form key doesn't exist
 *   410 when the form's `enabled` flag is off
 */
export const POST: RequestHandler = async ({
  request,
  params,
  platform,
  locals,
  getClientAddress,
}) => {
  const form = await locals.content.getFormByKey(params.key);
  if (!form) throw error(404, "Form not found");
  if (!form.enabled) throw error(410, "Form is no longer accepting submissions");

  // Parse the body. Forms are typically posted as
  // application/x-www-form-urlencoded; multipart works too.
  let payload: Record<string, FormDataEntryValue>;
  try {
    const fd = await request.formData();
    payload = Object.fromEntries(fd.entries());
  } catch {
    throw error(400, "Could not parse form body");
  }

  const validation = validateSubmission(form, payload);
  if (!validation.ok) {
    // We deliberately return 400 with the same shape for honeypot +
    // real validation errors. Bots learn nothing about which check
    // fired; humans see a useful message.
    throw error(400, validation.error);
  }

  // Per-IP rate limit. Hash the IP so we can match without storing
  // the raw value. Best-effort: a missing client address skips the
  // check (Cloudflare always supplies one in production).
  let ipHash: string | undefined;
  try {
    const ip = getClientAddress();
    if (ip) ipHash = await hashIp(ip);
  } catch {
    // ignore; getClientAddress may throw in dev
  }

  if (ipHash) {
    const recent = await locals.content.countRecentSubmissions(
      form.id,
      ipHash,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (recent >= RATE_LIMIT_MAX_PER_WINDOW) {
      throw error(429, "Too many submissions. Please try again in a minute.");
    }
  }

  const submission = await locals.content.createFormSubmission({
    formId: form.id,
    data: validation.data,
    ipHash,
  });

  if (platform?.env?.DB) {
    // Audit-log every submission so the editor's audit feed surfaces
    // form activity alongside content events. Best-effort.
    await logAudit(
      platform.env.DB,
      // No actor — public submission. We pass null so the FK doesn't
      // resolve to a real user; the audit row's userId is nullable
      // (ON DELETE SET NULL).
      null,
      "form.submit",
      submission.id,
      { formKey: form.key, formLabel: form.label },
    );
  }

  // v2.0d: fan out the form.submit event. Receivers get the
  // submission id + form key + the data payload so they can route
  // (e.g. CRM ingest, Slack notification, etc.).
  void dispatchEvent(locals.content, {
    event: "form.submit",
    payload: {
      submissionId: submission.id,
      formKey: form.key,
      formLabel: form.label,
      data: validation.data,
    },
  });

  return json(
    {
      ok: true,
      id: submission.id,
      message: form.successMessages.en ?? "Thanks — we'll be in touch.",
    },
    { status: 201 },
  );
};

// Keep TS happy when the import is otherwise tree-shaken.
void HONEYPOT_FIELD;
