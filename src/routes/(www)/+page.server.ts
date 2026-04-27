import { redirect } from "@sveltejs/kit";
import { cookieName } from "$lib/paraglide/runtime";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, toLocale } from "$lib/i18n";
import type { PageServerLoad } from "./$types";

/**
 * Bare `/` has no content of its own — the public site lives under
 * `/en/...` and `/th/...`. Pick the best locale for this visitor and
 * 308-redirect them there so search engines and shared links always
 * land on a localized URL.
 *
 * Locale precedence (matches Paraglide's strategy `["url","cookie",
 * "baseLocale"]`):
 *   1. PARAGLIDE_LOCALE cookie (if previously set via the toggle)
 *   2. Accept-Language header
 *   3. DEFAULT_LOCALE
 */
export const load: PageServerLoad = async ({ cookies, request }) => {
  const cookieLocale = cookies.get(cookieName);
  if (cookieLocale && SUPPORTED_LOCALES.includes(toLocale(cookieLocale))) {
    throw redirect(308, `/${cookieLocale}`);
  }

  const accept = request.headers.get("accept-language") ?? "";
  for (const tag of accept.split(",")) {
    const lang = tag.trim().split(/[-;]/)[0]?.toLowerCase();
    if (lang && SUPPORTED_LOCALES.includes(toLocale(lang))) {
      throw redirect(308, `/${lang}`);
    }
  }

  throw redirect(308, `/${DEFAULT_LOCALE}`);
};
