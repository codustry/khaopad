import { redirect } from "@sveltejs/kit";
import { cookieName } from "$lib/paraglide/runtime";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "$lib/i18n";
import type { Locale } from "$lib/server/content/types";
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
  // NOTE: check membership against the RAW value, never `toLocale(...)`.
  // toLocale() coerces anything unknown to DEFAULT_LOCALE, so
  // `SUPPORTED_LOCALES.includes(toLocale(x))` is true for EVERY input —
  // an inert guard. The redirect then used the raw tag, so
  // `Accept-Language: *` (a valid wildcard per RFC 9110, and what Node's
  // fetch sends by default) produced `Location: /*` and a 404 on the
  // site root. Same for any unknown tag: `zz` → `/zz`.
  const cookieLocale = cookies.get(cookieName);
  if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale as Locale)) {
    throw redirect(308, `/${cookieLocale}`);
  }

  const accept = request.headers.get("accept-language") ?? "";
  for (const tag of accept.split(",")) {
    const lang = tag.trim().split(/[-;]/)[0]?.toLowerCase();
    if (lang && SUPPORTED_LOCALES.includes(lang as Locale)) {
      throw redirect(308, `/${lang}`);
    }
  }

  throw redirect(308, `/${DEFAULT_LOCALE}`);
};
