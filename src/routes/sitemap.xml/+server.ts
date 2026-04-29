import { resolveOrigin } from "$lib/seo";
import { SUPPORTED_LOCALES } from "$lib/i18n";
import type { RequestHandler } from "./$types";

/**
 * GET /sitemap.xml
 *
 * Sitemap index. Points at one per-locale child sitemap so each locale
 * can be crawled independently. Search engines treat the index as a
 * stable entry point — adding a new locale only requires adding an
 * entry here, not regenerating any per-article state.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);

  const entries = SUPPORTED_LOCALES.map(
    (l) =>
      `  <sitemap><loc>${origin}/sitemap-${l}.xml</loc></sitemap>`,
  ).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
};
