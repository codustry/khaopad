import { redirect } from "@sveltejs/kit";
import { DEFAULT_LOCALE } from "$lib/i18n";
import type { RequestHandler } from "./$types";

/**
 * GET /feed.xml
 *
 * Default-locale shortcut. Redirects to /feed-{defaultLocale}.xml so
 * we have a single canonical feed URL but still support per-locale
 * feeds for bilingual readers.
 */
export const GET: RequestHandler = async () => {
  throw redirect(302, `/feed-${DEFAULT_LOCALE}.xml`);
};
