import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  // Site settings are surfaced on every (www) page so the <Seo />
  // component in the layout can fall back to siteName / description
  // when a page omits those fields. Best-effort: a missing settings
  // row should not 500 the public site.
  const siteSettings = await locals.content.getSettings().catch(() => null);

  return {
    locale: locals.locale,
    siteSettings,
  };
};
