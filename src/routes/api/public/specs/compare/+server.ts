/**
 * GET /api/public/specs/compare — side-by-side comparison table.
 *
 *   /api/public/specs/compare?type=entry&ids=a100,a200,a300&locale=en
 *
 * Returns rows × entities, pivoted so a template renders one table row
 * per spec with one column per entity — the shape #88 says rich text
 * cannot produce. Attributes absent on an entity come back as `null`
 * rather than being omitted, so columns stay aligned.
 */
import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import { createAttributeService } from "$lib/server/content/attributes";
import type { RequestHandler } from "./$types";

const PUBLIC_ENTITY_TYPES = new Set(["entry", "shop_variant", "shop_product"]);

/**
 * A comparison table stops being readable long before this, and each id
 * costs a bound parameter — capped so a crafted `ids=` can't turn one
 * request into an unbounded query.
 */
const MAX_COMPARE = 12;

export const GET: RequestHandler = async ({
  url,
  request,
  locals,
  platform,
}) => {
  const env = platform?.env;
  if (!env) return json({ error: "Platform not ready" }, { status: 503 });

  const entityType = url.searchParams.get("type") ?? "entry";
  if (!PUBLIC_ENTITY_TYPES.has(entityType)) {
    return json(
      { error: `Unknown entity type "${entityType}"` },
      { status: 404 },
    );
  }

  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, "*:read")) {
    return json(
      { error: "Forbidden — *:read scope required" },
      { status: 403 },
    );
  }

  const ids = Array.from(
    new Set(
      (url.searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
  if (ids.length === 0) {
    return json(
      { error: "ids is required (comma-separated)" },
      { status: 400 },
    );
  }
  if (ids.length > MAX_COMPARE) {
    return json(
      { error: `Cannot compare more than ${MAX_COMPARE} entities at once` },
      { status: 400 },
    );
  }

  const locale = url.searchParams.get("locale") ?? undefined;
  const service = createAttributeService(env);

  try {
    const result = await service.compare(entityType, ids, locale);
    return json(
      { data: { entityType, ...result } },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Comparison failed" },
      { status: 400 },
    );
  }
};
