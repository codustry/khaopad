/**
 * GET /api/public/entries/[collection] — read user-defined content.
 *
 * The Phase 2 counterpart to `/api/public/content/[collection]`, which
 * serves the built-in code-defined types. Same Strapi-shaped params,
 * same engine, same populate/cache behaviour — the only difference is
 * that these collections were created by inserting registry rows rather
 * than by writing Drizzle schema:
 *
 *   /api/public/entries/product_line
 *     ?populate=variants,brand&locale=th&sort=-publishedAt
 *
 * ## Auth
 *
 * Registry collections have no per-collection API scope — scopes are a
 * closed union in the code (`articles:read` … ), and a user-defined type
 * cannot mint a new one at runtime. So this endpoint requires the
 * catch-all `*:read`. That is deliberately conservative: a key limited
 * to `articles:read` must not silently gain access to every content type
 * an admin invents later.
 *
 * Per-collection scopes for registry types need the scope column to
 * become open text, which is a migration and an admin-UI change — out of
 * scope for Phase 2 and explicitly out of scope for the whole task
 * ("no per-collection RBAC").
 */
import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import { parseFindQuery, QueryError } from "$lib/server/content/query";
import { createRegistryQuery } from "$lib/server/content/registry";
import type { RequestHandler } from "./$types";

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

  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, "*:read")) {
    return json(
      {
        error: "Forbidden — *:read scope required for user-defined collections",
      },
      { status: 403 },
    );
  }

  const registry = createRegistryQuery(env);

  // 404 before parsing, so a bad collection name doesn't surface as a
  // confusing filter error.
  const available = await registry.listCollections();
  if (!available.includes(params.collection)) {
    return json(
      { error: `Unknown collection "${params.collection}"` },
      { status: 404 },
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

  // Published-only, and the scheduled-publishing guard applied by the
  // engine. Set after parsing so a caller's own `filters[status]` is
  // overwritten rather than merged.
  const filters = { ...(query.filters ?? {}), status: { $eq: "published" } };

  try {
    const result = await registry.findCached(params.collection, {
      ...query,
      filters,
      onlyPublished: true,
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
