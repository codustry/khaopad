import { error } from "@sveltejs/kit";
import { resolveOrigin } from "$lib/seo";
import { SUPPORTED_LOCALES } from "$lib/i18n";
import type { Locale } from "$lib/server/content/types";
import type { RequestHandler } from "./$types";

/**
 * GET /sitemap-en.xml | /sitemap-th.xml
 *
 * Per-locale sitemap. Lists every published article in this locale
 * (respecting scheduled publishing) and the static landing pages.
 * Each <url> entry includes <xhtml:link rel="alternate"> pairs so
 * search engines can pick the right locale per region.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const locale = params.locale as Locale;
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw error(404, "Unknown locale");
  }

  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);

  // Pull every published article + page visible to the public. Pages
  // are tiny by count; articles capped at 500 (overkill for typical
  // CMS scale, bounded memory if a site ever grows).
  const [articles, pages] = await Promise.all([
    locals.content.listArticles({
      status: "published",
      onlyPublished: true,
      locale,
      page: 1,
      limit: 500,
    }),
    locals.content.listPages({ status: "published", onlyPublished: true }),
  ]);

  const staticUrls = [
    { path: `/${locale}`, lastmod: new Date().toISOString() },
    { path: `/${locale}/blog`, lastmod: new Date().toISOString() },
  ];

  const articleUrls = articles.items.map((a) => ({
    path: `/${locale}/blog/${a.slug}`,
    lastmod: a.updatedAt,
    /** alternates only include locales that actually have content */
    alternates: SUPPORTED_LOCALES.filter((l) => a.localizations[l]).map(
      (l) => ({ locale: l, path: `/${l}/blog/${a.slug}` }),
    ),
  }));

  // Include pages that have a localization in this locale (or fall back
  // to EN). Hreflang siblings only for locales with real content.
  const pageUrls = pages
    .filter((p) => p.localizations[locale] || p.localizations.en)
    .map((p) => ({
      path: `/${locale}/${p.slug}`,
      lastmod: p.updatedAt,
      alternates: SUPPORTED_LOCALES.filter((l) => p.localizations[l]).map(
        (l) => ({ locale: l, path: `/${l}/${p.slug}` }),
      ),
    }));

  const renderEntry = (e: {
    path: string;
    lastmod: string;
    alternates?: Array<{ locale: Locale; path: string }>;
  }): string => {
    const alts = (e.alternates ?? [])
      .map(
        (a) =>
          `    <xhtml:link rel="alternate" hreflang="${a.locale}" href="${origin}${a.path}" />`,
      )
      .join("\n");
    return `  <url>
    <loc>${origin}${e.path}</loc>
    <lastmod>${e.lastmod}</lastmod>
${alts}
  </url>`;
  };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[...staticUrls, ...pageUrls, ...articleUrls].map(renderEntry).join("\n")}
</urlset>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
};
