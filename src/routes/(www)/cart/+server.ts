/**
 * Redirect stub: /cart → /{locale}/cart (#141).
 *
 * The funnel moved under /[locale]/ because Paraglide's `url` strategy
 * treats an unprefixed path as the base locale — it *resolves* rather
 * than falling through to the cookie — so these pages could never
 * hydrate in any locale but English. The unprefixed URL survives as a
 * redirect because the shop plugin's client code and outbound emails
 * still target it (abandoned-cart emails, `goto('/cart')` habits).
 *
 * Locale: cookie if the visitor has expressed one, default otherwise —
 * the same order the header toggle writes it.
 */
import { redirect } from "@sveltejs/kit";
import { cookieName } from "$lib/paraglide/runtime";
import { DEFAULT_LOCALE, localePath, toLocale } from "$lib/i18n";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ cookies, url }) => {
  const locale = toLocale(cookies.get(cookieName) ?? DEFAULT_LOCALE);
  throw redirect(303, localePath(locale, "/cart") + url.search);
};
