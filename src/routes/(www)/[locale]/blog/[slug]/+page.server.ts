import { error } from '@sveltejs/kit';
import { marked } from 'marked';
import type { PageServerLoad } from './$types';
import type { Locale } from '$lib/server/content/types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const locale = params.locale as Locale;
	const article = await locals.content.getArticleBySlug(params.slug);

	if (!article || article.status !== 'published') {
		throw error(404, 'Article not found');
	}

	const localization = article.localizations[locale];
	if (!localization) {
		throw error(404, 'Article not available in this language');
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
		seo: {
			title: localization.seoTitle ?? localization.title,
			description: localization.seoDescription ?? localization.excerpt,
		},
	};
};
