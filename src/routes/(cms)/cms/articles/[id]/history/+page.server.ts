import { error, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";
import * as schema from "$lib/server/content/schema";
import { canEditArticle } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params, platform }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  const article = await locals.content.getArticle(params.id);
  if (!article) throw error(404, "Article not found");
  if (!canEditArticle(locals.user, article.authorId)) {
    throw error(403, "You're not allowed to view this article's history.");
  }
  if (!platform?.env?.DB) throw error(503, "Platform not configured");

  const versions = await locals.content.listArticleVersions(params.id);

  // Resolve actor names in one query for the timeline UI.
  const actorIds = [
    ...new Set(
      versions.map((v) => v.createdBy).filter((x): x is string => !!x),
    ),
  ];
  const actors = actorIds.length
    ? await drizzle(platform.env.DB, { schema })
        .select({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, actorIds))
        .all()
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  return {
    article,
    versions: versions.map((v) => ({
      ...v,
      actor: v.createdBy ? (actorById.get(v.createdBy) ?? null) : null,
    })),
  };
};
