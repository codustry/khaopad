import { error, fail, redirect } from "@sveltejs/kit";
import { canManageSettings } from "$lib/server/auth/permissions";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageSettings(locals.user)) {
    throw error(403, "Only admins and super admins can manage site settings.");
  }
  const settings = await locals.content.getSettings();
  return { settings };
};

function requireSettingsManager(locals: App.Locals) {
  if (!locals.user) throw error(401, "Not authenticated");
  if (!canManageSettings(locals.user)) {
    throw error(403, "Only admins and super admins can manage site settings.");
  }
}

/** Coerce a comma-separated locale string (e.g. "en,th") into a clean array. */
function parseLocales(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Loose locale shape — narrowed to the project's Locale union by the time
 *  we hand it to updateSettings. We don't import Locale here to avoid
 *  circular deps; getSettings() round-trips through `SiteSettings` shape. */

export const actions: Actions = {
  default: async ({ request, locals }) => {
    requireSettingsManager(locals);

    const form = await request.formData();
    const siteName = String(form.get("site_name") ?? "").trim();
    const defaultLocale = String(form.get("default_locale") ?? "").trim();
    const supportedLocalesRaw = String(
      form.get("supported_locales") ?? "",
    ).trim();
    const cdnBaseUrl = String(form.get("cdn_base_url") ?? "").trim();

    if (!siteName) return fail(400, { error: "Site name is required." });
    const supported = parseLocales(supportedLocalesRaw);
    if (supported.length === 0) {
      return fail(400, { error: "At least one supported locale is required." });
    }
    if (!supported.includes(defaultLocale)) {
      return fail(400, {
        error: `Default locale "${defaultLocale}" must be one of the supported locales (${supported.join(", ")}).`,
      });
    }

    try {
      await locals.content.updateSettings({
        siteName,
        // The Locale union is narrow ("en" | "th") in our project today.
        // We trust the supported-locales validation above and cast.
        defaultLocale: defaultLocale as "en" | "th",
        supportedLocales: supported as Array<"en" | "th">,
        cdnBaseUrl: cdnBaseUrl || undefined,
      });
    } catch (err) {
      return fail(500, {
        error: err instanceof Error ? err.message : "Failed to save settings",
      });
    }

    return { ok: true };
  },
};
