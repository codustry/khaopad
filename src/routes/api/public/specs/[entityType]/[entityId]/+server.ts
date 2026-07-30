/**
 * GET /api/public/specs/[entityType]/[entityId] — one entity's datasheet.
 *
 * The Phase 3 (#88) read path that rich text can't provide: typed,
 * unit-aware spec rows grouped for rendering.
 *
 *   /api/public/specs/entry/a100?locale=th
 *
 * Each row carries BOTH numbers:
 *   `standardValue` — canonical magnitude, for client-side sorting
 *   `displayValue` + `unit` — as the editor authored it, for rendering
 *
 * So a client can sort a table by flow rate without re-deriving units,
 * and still print "0.1 mbar" rather than "10 Pa".
 */
import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import { createAttributeService } from "$lib/server/content/attributes";
import type { RequestHandler } from "./$types";

/**
 * Entity types readable through this endpoint.
 *
 * `entity_type` is free text in the schema (deliberately — values attach
 * to anything with a stable id), but the PUBLIC surface is an allowlist:
 * without it, a caller could enumerate specs attached to internal entity
 * types that were never meant to be published.
 */
const PUBLIC_ENTITY_TYPES = new Set(["entry", "shop_variant", "shop_product"]);

/**
 * Sibling static routes under /specs. SvelteKit ranks static segments
 * above dynamic ones, so `/specs/compare` and `/specs/facet/x` reach
 * their own handlers — but neither is a valid entity type, and listing
 * them here means a future rename can't silently make this route shadow
 * one of them.
 */
const RESERVED_SEGMENTS = new Set(["compare", "facet"]);

export const GET: RequestHandler = async ({
  params,
  url,
  request,
  locals,
  platform,
}) => {
  const env = platform?.env;
  if (!env) return json({ error: "Platform not ready" }, { status: 503 });

  if (
    RESERVED_SEGMENTS.has(params.entityType) ||
    !PUBLIC_ENTITY_TYPES.has(params.entityType)
  ) {
    return json(
      { error: `Unknown entity type "${params.entityType}"` },
      { status: 404 },
    );
  }

  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  // Specs describe content across collection types, and API scopes are a
  // closed union in code, so there is no `specs:read` to mint. `*:read`
  // is the conservative choice — a key limited to `articles:read` should
  // not silently gain the spec surface.
  if (!hasScope(auth.key, "*:read")) {
    return json(
      { error: "Forbidden — *:read scope required" },
      { status: 403 },
    );
  }

  const locale = url.searchParams.get("locale") ?? undefined;
  const service = createAttributeService(env);

  try {
    const groups = await service.datasheet(
      params.entityType,
      params.entityId,
      locale,
    );
    return json(
      {
        data: {
          entityType: params.entityType,
          entityId: params.entityId,
          groups,
        },
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Failed to load specs" },
      { status: 400 },
    );
  }
};
