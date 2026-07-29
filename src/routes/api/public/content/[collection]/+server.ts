/**
 * GET /api/public/content/[collection] — generic relational read.
 *
 * The Phase 1 (#68) answer to "the API returns bare FK ids." One
 * request returns a fully-populated nested graph:
 *
 *   /api/public/content/articles
 *     ?populate=category,tags,localizations
 *     &filters[status][$eq]=published
 *     &sort=-publishedAt
 *     &locale=th
 *     &limit=20
 *
 * Params are Strapi-shaped (see query/params.ts). Auth reuses the
 * existing bearer-token + scope machinery — this endpoint requires the
 * same `<collection>:read` scope the per-entity endpoints do, so it
 * grants nothing a key couldn't already reach.
 *
 * The existing `/api/public/articles` etc. are untouched and still
 * work; this is additive.
 */
import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import {
  createQueryEngine,
  getCollection,
  parseFindQuery,
  QueryError,
} from "$lib/server/content/query";
import type { ApiKeyScope } from "$lib/server/content/types";
import type { RequestHandler } from "./$types";

/**
 * Collections reachable through this endpoint, each mapped to the
 * scope that unlocks it. Written as an explicit record rather than
 * templating `${collection}:read` so the scope strings stay typed —
 * a new collection can't silently become reachable without someone
 * adding a scope for it.
 *
 * The query registry also describes `media`, which is deliberately
 * absent here: media is served through its own route with its own
 * access rules. It stays reachable as a *populate target*, which only
 * ever exposes the columns in its `selectable` allowlist.
 */
const PUBLIC_ROOTS: Record<string, ApiKeyScope> = {
  articles: "articles:read",
  categories: "categories:read",
  tags: "tags:read",
  pages: "pages:read",
};

export const GET: RequestHandler = async ({
  params,
  url,
  request,
  locals,
  platform,
}) => {
  const env = platform?.env;
  if (!env) {
    return json({ error: "Platform not ready" }, { status: 503 });
  }

  const collection = params.collection;
  const scope = Object.prototype.hasOwnProperty.call(PUBLIC_ROOTS, collection)
    ? PUBLIC_ROOTS[collection]
    : undefined;
  if (!scope || !getCollection(collection)) {
    return json(
      { error: `Unknown collection "${collection}"` },
      { status: 404 },
    );
  }

  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, scope)) {
    return json(
      { error: `Forbidden — ${scope} scope required` },
      { status: 403 },
    );
  }

  let query;
  try {
    query = parseFindQuery(url);
  } catch (err) {
    if (err instanceof QueryError) {
      return json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }

  // Public reads are published-only. Applied AFTER parsing so a caller
  // cannot widen it via their own `filters[status]` — this overwrites
  // whatever they sent.
  //
  // `status` alone is NOT sufficient: scheduled publishing sets
  // status='published' with a future publishedAt, and the row must stay
  // hidden until that moment. Every other public read path applies this
  // same guard (d1.ts listArticles' `onlyPublished`, searchArticles);
  // omitting it here would make this endpoint the one way to read an
  // embargoed post early.
  //
  // A null publishedAt means "publish immediately when status flips",
  // matching listArticles' behaviour, so it passes the guard. That
  // `publishedAt IS NULL OR publishedAt <= now` disjunction can't be
  // expressed in the AND-only filter grammar, so it rides as a separate
  // `onlyPublished` flag the engine applies itself.
  const filters = { ...(query.filters ?? {}) };
  const schedulable = collection === "articles" || collection === "pages";
  if (schedulable) {
    filters.status = { $eq: "published" };
  }

  const engine = createQueryEngine(env);
  try {
    // Cacheable: published-only, no per-user variation.
    const result = await engine.findCached(collection, {
      ...query,
      filters,
      onlyPublished: schedulable,
    });
    return json(
      { data: result.data, meta: result.meta },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (err) {
    if (err instanceof QueryError) {
      return json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
};
