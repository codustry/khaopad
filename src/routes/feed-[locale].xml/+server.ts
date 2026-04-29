import { error } from "@sveltejs/kit";
import { marked } from "marked";
import { resolveOrigin } from "$lib/seo";
import { SUPPORTED_LOCALES } from "$lib/i18n";
import type { Locale } from "$lib/server/content/types";
import type { RequestHandler } from "./$types";

const FEED_LIMIT = 50;

/**
 * GET /feed-en.xml | /feed-th.xml
 *
 * RSS 2.0 feed of the most recent published articles for one locale.
 * Full content goes inside <content:encoded> (CDATA-wrapped) so feed
 * readers can render the article body without re-fetching.
 *
 * Articles are filtered through the same scheduled-publishing rules
 * the public site uses — a future-dated article won't appear in the
 * feed before its publish moment.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const locale = params.locale as Locale;
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw error(404, "Unknown locale");
  }

  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);
  const siteName = settings?.siteName ?? "Khao Pad";
  const feedUrl = `${origin}/feed-${locale}.xml`;
  const homeUrl = `${origin}/${locale}`;

  const articles = await locals.content.listArticles({
    status: "published",
    onlyPublished: true,
    locale,
    page: 1,
    limit: FEED_LIMIT,
  });

  const items = await Promise.all(
    articles.items.map(async (a) => {
      const loc = a.localizations[locale] ?? a.localizations.en;
      if (!loc) return null;
      const link = `${origin}/${locale}/blog/${a.slug}`;
      const html = await marked(loc.body);
      const pubDate = new Date(
        a.publishedAt ?? a.createdAt,
      ).toUTCString();
      return { link, title: loc.title, excerpt: loc.excerpt, html, pubDate };
    }),
  );

  const itemXml = items
    .filter((i): i is NonNullable<typeof i> => Boolean(i))
    .map(
      (i) => `    <item>
      <title>${escapeXml(i.title)}</title>
      <link>${i.link}</link>
      <guid isPermaLink="true">${i.link}</guid>
      <pubDate>${i.pubDate}</pubDate>
      ${i.excerpt ? `<description>${escapeXml(i.excerpt)}</description>` : ""}
      <content:encoded><![CDATA[${i.html}]]></content:encoded>
    </item>`,
    )
    .join("\n");

  const lastBuildDate = items.find((i) => i)?.pubDate ?? new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteName)} (${locale.toUpperCase()})</title>
    <link>${homeUrl}</link>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />
    <description>Latest articles from ${escapeXml(siteName)}</description>
    <language>${locale}</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${itemXml}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
};

/** Minimal XML escaping for RSS title/description values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
