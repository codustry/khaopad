import { error, fail, redirect } from "@sveltejs/kit";
import { canManageUsers } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { WEBHOOK_EVENTS, type WebhookEvent } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

/**
 * `/cms/webhooks` — admin+ only. Lists registered webhooks. Creating
 * one shows the secret once at create time; the operator must save it
 * (we hash with the same secret in the dispatcher's HMAC, but the
 * stored secret stays visible in the CMS for verification — webhooks
 * aren't quite as sensitive as API keys, since the receiver chooses
 * to consume the URL).
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageUsers(locals.user)) {
    throw error(403, "Only admins can manage webhooks.");
  }
  const webhooks = await locals.content.listWebhooks();
  return { webhooks, knownEvents: WEBHOOK_EVENTS };
};

function parseEvents(form: FormData): WebhookEvent[] {
  return form
    .getAll("events")
    .map((v) => String(v))
    .filter((v): v is WebhookEvent =>
      (WEBHOOK_EVENTS as string[]).includes(v),
    );
}

export const actions: Actions = {
  create: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) return fail(403, { error: "Forbidden" });
    const fd = await request.formData();
    const label = String(fd.get("label") ?? "").trim();
    const url = String(fd.get("url") ?? "").trim();
    const events = parseEvents(fd);
    const enabled = fd.get("enabled") !== "off";
    if (!label || !url) {
      return fail(400, { error: "Label and URL are required." });
    }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      return fail(400, { error: "URL must start with http:// or https://" });
    }
    if (events.length === 0) {
      return fail(400, { error: "Pick at least one event." });
    }
    const webhook = await locals.content.createWebhook({
      label,
      url,
      events,
      enabled,
      createdBy: locals.user.id,
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        webhook.id,
        { kind: "webhook.create", url },
      );
    }
    return { ok: true, webhookId: webhook.id };
  },

  update: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) return fail(403, { error: "Forbidden" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    const label = String(fd.get("label") ?? "").trim();
    const url = String(fd.get("url") ?? "").trim();
    const events = parseEvents(fd);
    const enabled = fd.get("enabled") !== "off";
    if (!id || !label || !url) {
      return fail(400, { error: "Missing required fields." });
    }
    if (events.length === 0) {
      return fail(400, { error: "Pick at least one event." });
    }
    await locals.content.updateWebhook(id, { label, url, events, enabled });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "webhook.update", url },
      );
    }
    return { ok: true };
  },

  rotate: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) return fail(403, { error: "Forbidden" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });
    await locals.content.rotateWebhookSecret(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "webhook.rotate_secret" },
      );
    }
    return { ok: true };
  },

  delete: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) return fail(403, { error: "Forbidden" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });
    await locals.content.deleteWebhook(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "webhook.delete" },
      );
    }
    return { ok: true };
  },
};
