/**
 * Redirect stub: /lookup → /{locale}/lookup (#141). See cart/+server.ts
 * for the full rationale — the funnel moved under /[locale]/ so Paraglide
 * resolves the same locale on server and client.
 */
import { redirect } from "@sveltejs/kit";
import { cookieName } from "$lib/paraglide/runtime";
import { DEFAULT_LOCALE, localePath, toLocale } from "$lib/i18n";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ cookies, url }) => {
  const locale = toLocale(cookies.get(cookieName) ?? DEFAULT_LOCALE);
  throw redirect(303, localePath(locale, "/lookup") + url.search);
};
