import { error } from "@sveltejs/kit";
import { marked } from "marked";
import { toLocale } from "$lib/i18n";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  const locale = toLocale(params.locale);
  const article = await locals.content.getArticleBySlug(params.slug);

  if (!article || article.status !== "published") {
    throw error(404, "Article not found");
  }

  // Scheduled-publishing guard: a published article with a future
  // `publishedAt` is not yet visible to the public.
  if (article.publishedAt && new Date(article.publishedAt) > new Date()) {
    throw error(404, "Article not found");
  }

  // Slug is shared across locales; fall back to English (the canonical) if the
  // requested locale's content is missing.
  const localization =
    article.localizations[locale] ?? article.localizations.en;
  if (!localization) {
    throw error(404, "Article not available");
  }

  const htmlContent = await marked(localization.body);

  return {
    locale,
    title: localization.title,
    excerpt: localization.excerpt,
    htmlContent,
    publishedAt: article.publishedAt,
    createdAt: article.createdAt,
    slug: article.slug,
    coverMediaId: article.coverMediaId,
    seo: {
      title: localization.seoTitle ?? localization.title,
      description: localization.seoDescription ?? localization.excerpt,
    },
  };
};
