import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import type { RequestHandler } from "./$types";

/**
 * GET /api/public/articles
 *
 * Public read-only API (v2.0d). Bearer auth via `Authorization: Bearer
 * kp_live_…` header. Requires `articles:read` (or `*:read`) scope.
 *
 * Query params:
 *   ?locale=en|th    — restrict to a single locale (default: all)
 *   ?limit=NUM       — max 100, default 20
 *   ?page=NUM        — 1-based, default 1
 *
 * Always returns published, non-future-dated articles only — consumers
 * never see drafts or scheduled posts.
 */
export const GET: RequestHandler = async ({ request, url, locals }) => {
  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, "articles:read")) {
    return json({ error: "Forbidden — articles:read scope required" }, { status: 403 });
  }

  const localeParam = url.searchParams.get("locale");
  const locale =
    localeParam === "en" || localeParam === "th" ? localeParam : undefined;
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20),
  );
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const result = await locals.content.listArticles({
    status: "published",
    onlyPublished: true,
    locale,
    limit,
    page,
  });

  return json(
    {
      data: result.items.map((a) => ({
        id: a.id,
        slug: a.slug,
        publishedAt: a.publishedAt,
        updatedAt: a.updatedAt,
        coverMediaId: a.coverMediaId,
        categoryId: a.categoryId,
        tagIds: a.tagIds,
        localizations: a.localizations,
      })),
      meta: { total: result.total, page: result.page, limit: result.limit },
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
};
