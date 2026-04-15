import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const locale = params.locale;

	const articles = await locals.content.listArticles({
		status: 'published',
		locale: locale as 'th' | 'en',
		page: 1,
		limit: 20,
	});

	return {
		locale,
		articles,
	};
};
