import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const articles = await locals.content.listArticles({ page: 1, limit: 50 });

  return { articles };
};
