import { error, redirect } from "@sveltejs/kit";
import { marked } from "marked";
import { toLocale, SUPPORTED_LOCALES } from "$lib/i18n";
import {
  articleJsonLd,
  canonicalUrl,
  resolveOrigin,
  type PageSeo,
} from "$lib/seo";
import { expandBlocks } from "$lib/server/content/blocks";
import type { Locale } from "$lib/server/content/types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const locale = toLocale(params.locale);
  const article = await locals.content.getArticleBySlug(params.slug);

  // Slug-redirect handling: before throwing 404, see if this old slug
  // points at a renamed article. If so, 301 to the new canonical URL.
  if (!article) {
    const target = await locals.content.resolveSlugRedirect(params.slug);
    if (target) {
      throw redirect(301, `/${locale}/blog/${target}`);
    }
    throw error(404, "Article not found");
  }

  if (article.status !== "published") {
    throw error(404, "Article not found");
  }

  // Scheduled-publishing guard.
  if (article.publishedAt && new Date(article.publishedAt) > new Date()) {
    throw error(404, "Article not found");
  }

  // Slug is shared across locales; fall back to English (the canonical)
  // if the requested locale's content is missing.
  const localization =
    article.localizations[locale] ?? article.localizations.en;
  if (!localization) {
    throw error(404, "Article not available");
  }

  // Expand v1.7 reusable-block shortcodes before passing to `marked`.
  // Cheap no-op when the body has no `{{block:` substring.
  const expanded = await expandBlocks(
    localization.body,
    locals.content,
    locale,
  );
  const htmlContent = await marked(expanded);

  // SEO surface for the public article page.
  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);
  const canonical = canonicalUrl(
    origin,
    `/${locale}/blog/${article.slug}`,
  );
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    if (article.localizations[l]) {
      alternates[l] = canonicalUrl(origin, `/${l}/blog/${article.slug}`);
    }
  }
  const image = article.coverMediaId
    ? `${origin}/api/media/${article.coverMediaId}`
    : undefined;
  const seoTitle = localization.seoTitle ?? localization.title;
  const seoDescription =
    localization.seoDescription ?? localization.excerpt ?? undefined;

  const seo: PageSeo = {
    title: seoTitle,
    description: seoDescription,
    canonical,
    locale,
    alternates,
    image,
    ogType: "article",
    publishedTime: article.publishedAt ?? article.createdAt,
    modifiedTime: article.updatedAt,
    jsonLd: [
      articleJsonLd({
        url: canonical,
        headline: seoTitle,
        description: seoDescription,
        datePublished: article.publishedAt ?? article.createdAt,
        dateModified: article.updatedAt,
        // The article record has authorId but not the resolved name on
        // the public read path. Use the site name as a stable byline
        // attribution; resolving the user table on every public read
        // is a separate v1.7+ concern.
        authorName: settings?.siteName ?? "Khao Pad",
        image,
        publisherName: settings?.siteName ?? "Khao Pad",
      }),
    ],
  };

  return {
    locale,
    title: localization.title,
    excerpt: localization.excerpt,
    htmlContent,
    publishedAt: article.publishedAt,
    createdAt: article.createdAt,
    slug: article.slug,
    coverMediaId: article.coverMediaId,
    seo,
  };
};
