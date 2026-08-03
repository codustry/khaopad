/**
 * Redirect stub: /order/[n] → /{locale}/order/[n] (#141).
 *
 * This one carries real traffic: receipt emails and the Beam payment
 * return URL both point here. `url.search` is preserved because the
 * lookup flow authenticates with `?email=` — dropping it would bounce
 * every guest back to the lookup form.
 */
import { redirect } from "@sveltejs/kit";
import { cookieName } from "$lib/paraglide/runtime";
import { DEFAULT_LOCALE, localePath, toLocale } from "$lib/i18n";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ cookies, url, params }) => {
  const locale = toLocale(cookies.get(cookieName) ?? DEFAULT_LOCALE);
  throw redirect(
    303,
    localePath(locale, `/order/${encodeURIComponent(params.orderNumber)}`) +
      url.search,
  );
};
