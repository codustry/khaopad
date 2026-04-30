import { CONSENT_COOKIE, parseConsent } from "$lib/consent";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  // Site settings are surfaced on every (www) page so the <Seo />
  // component in the layout can fall back to siteName / description
  // when a page omits those fields. Best-effort: a missing settings
  // row should not 500 the public site.
  const siteSettings = await locals.content.getSettings().catch(() => null);

  // v1.7 cookie consent. Forwarded so the banner can decide whether
  // to render and downstream feature gates (analytics in v1.8) can
  // skip work on un-consented visitors without re-parsing the cookie.
  const consent = parseConsent(cookies.get(CONSENT_COOKIE));

  return {
    locale: locals.locale,
    siteSettings,
    consent,
  };
};
