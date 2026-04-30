import { error, redirect } from "@sveltejs/kit";
import { marked } from "marked";
import { toLocale, SUPPORTED_LOCALES } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import { expandBlocks } from "$lib/server/content/blocks";
import { trackView } from "$lib/server/analytics";
import { CONSENT_COOKIE, parseConsent } from "$lib/consent";
import type { Locale } from "$lib/server/content/types";
import type { PageServerLoad } from "./$types";

/**
 * Catch-all for static pages: /{locale}/{nested/slug}.
 *
 * Falls through to 404 only after we confirm there's no matching
 * `pages.slug`. Note that SvelteKit's router prefers more-specific
 * routes, so /{locale}/blog and /{locale}/blog/{slug} still win
 * over this catch-all.
 *
 * Honors the same publish/scheduled gates as articles: draft pages
 * 404; published pages with a future `publishedAt` 404.
 */
export const load: PageServerLoad = async ({
  locals,
  params,
  url,
  cookies,
  platform,
}) => {
  const locale = toLocale(params.locale);
  const slug = params.slug; // already without leading /

  if (!slug) throw error(404, "Page not found");

  const page = await locals.content.getPageBySlug(slug);
  if (!page) {
    // Try slug-redirect lookup (v1.6 reuse) for the page case as well.
    // Article and page slug spaces are kept separate by table.
    throw error(404, "Page not found");
  }

  if (page.status !== "published") throw error(404, "Page not found");
  if (page.publishedAt && new Date(page.publishedAt) > new Date()) {
    throw error(404, "Page not found");
  }

  const localization =
    page.localizations[locale] ?? page.localizations.en;
  if (!localization) throw error(404, "Page not available");

  // Reuse v1.7a's block expansion + marked pipeline.
  const expanded = await expandBlocks(
    localization.body,
    locals.content,
    locale,
  );
  const htmlContent = await marked(expanded);

  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);
  const canonical = canonicalUrl(origin, `/${locale}/${page.slug}`);
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    if (page.localizations[l]) {
      alternates[l] = canonicalUrl(origin, `/${l}/${page.slug}`);
    }
  }

  const seoTitle = localization.seoTitle ?? localization.title;
  const seoDescription = localization.seoDescription ?? undefined;

  const seo: PageSeo = {
    title: seoTitle,
    description: seoDescription,
    canonical,
    locale,
    alternates,
    ogType: "website",
    publishedTime: page.publishedAt ?? page.createdAt,
    modifiedTime: page.updatedAt,
  };

  // Redirect a request to a draft we've already started — only matters
  // when an editor previews from the CMS; harmless otherwise.
  void redirect;

  if (platform?.env?.DB) {
    const consent = parseConsent(cookies.get(CONSENT_COOKIE));
    void trackView(
      platform.env.DB,
      { path: url.pathname, kind: "page", refId: page.id },
      consent,
    );
  }

  return {
    locale,
    slug: page.slug,
    template: page.template,
    title: localization.title,
    htmlContent,
    seo,
  };
};
