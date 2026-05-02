import { error, fail, redirect } from "@sveltejs/kit";
import { canManageUsers } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import {
  isProviderConfigured,
  readNewsletterConfig,
} from "$lib/server/newsletter";
import type { Actions, PageServerLoad } from "./$types";

const PAGE_SIZE = 200;

/**
 * `/cms/subscribers` — newsletter subscriber management (v2.0b).
 *
 * Admin-only. The page works whether or not an email provider is
 * configured — when it isn't, the digest button just shows a disabled
 * state with a hint to wire up Resend in /cms/settings.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageUsers(locals.user)) {
    throw error(403, "Only admins can manage subscribers.");
  }
  const settings = await locals.content.getSettings().catch(() => null);
  const cfg = settings ? readNewsletterConfig(settings) : {};
  const [subscribers, totalActive] = await Promise.all([
    locals.content.listSubscribers({ limit: PAGE_SIZE }),
    locals.content.countSubscribers({ onlyActive: true }),
  ]);
  return {
    subscribers,
    totalActive,
    providerConfigured: isProviderConfigured(cfg),
  };
};

export const actions: Actions = {
  delete: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });
    await locals.content.deleteSubscriber(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "newsletter.delete",
        id,
        {},
      );
    }
    return { ok: true };
  },
};
