import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const [allArticles, publishedArticles, mediaFiles] = await Promise.all([
    locals.content.listArticles({ limit: 1 }),
    locals.content.listArticles({ status: "published", limit: 1 }),
    locals.media.list(),
  ]);

  return {
    stats: {
      articles: allArticles.total,
      published: publishedArticles.total,
      media: mediaFiles.length,
    },
  };
};
