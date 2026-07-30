/**
 * GET /api/public/specs/facet/[attributeKey] — faceted filter / sort.
 *
 * The capability #88 calls out as impossible with rich text: "facet the
 * whole catalog by pumping speed."
 *
 *   /api/public/specs/facet/flow_rate?min=100&max=300&unit=m3/h
 *   /api/public/specs/facet/flow_rate?min=1.67&unit=m3/min   ← same rows
 *   /api/public/specs/facet/oil_free?bool=true
 *   /api/public/specs/facet/pump_type?options=dry,oil_sealed
 *
 * The two flow examples select the same entities: bounds are normalized
 * into the attribute's standard unit before comparison, so a caller can
 * express a range in whatever unit they think in.
 */
import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import { createAttributeService } from "$lib/server/content/attributes";
import type { RequestHandler } from "./$types";

const PUBLIC_ENTITY_TYPES = new Set(["entry", "shop_variant", "shop_product"]);

export const GET: RequestHandler = async ({
  params,
  url,
  request,
  locals,
  platform,
}) => {
  const env = platform?.env;
  if (!env) return json({ error: "Platform not ready" }, { status: 503 });

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

  const p = url.searchParams;

  // Entity type is optional here (facet across everything by default),
  // but if supplied it must be a public one — otherwise this endpoint
  // becomes a way to enumerate internal entity types.
  const entityType = p.get("type") ?? undefined;
  if (entityType && !PUBLIC_ENTITY_TYPES.has(entityType)) {
    return json(
      { error: `Unknown entity type "${entityType}"` },
      { status: 404 },
    );
  }

  const service = createAttributeService(env);

  // Exactly one filter shape per request — accepting several at once
  // would make precedence ambiguous.
  const hasRange = p.has("min") || p.has("max");
  const hasOptions = p.has("options");
  const hasBool = p.has("bool");
  if ([hasRange, hasOptions, hasBool].filter(Boolean).length !== 1) {
    return json(
      {
        error:
          "Supply exactly one filter: min/max (range), options (select), or bool",
      },
      { status: 400 },
    );
  }

  const num = (key: string): number | undefined => {
    const raw = p.get(key);
    if (raw === null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  let filter: Parameters<typeof service.facet>[1];
  if (hasRange) {
    const min = num("min");
    const max = num("max");
    if (min === undefined && max === undefined) {
      return json(
        { error: "min and/or max must be finite numbers" },
        { status: 400 },
      );
    }
    if (min !== undefined && max !== undefined && min > max) {
      return json({ error: "min cannot exceed max" }, { status: 400 });
    }
    filter = {
      kind: "range",
      min,
      max,
      unit: p.get("unit") ?? undefined,
    };
  } else if (hasOptions) {
    const options = Array.from(
      new Set(
        (p.get("options") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    if (options.length === 0) {
      return json({ error: "options must be non-empty" }, { status: 400 });
    }
    filter = { kind: "option", options };
  } else {
    const raw = p.get("bool");
    if (raw !== "true" && raw !== "false") {
      return json({ error: "bool must be true or false" }, { status: 400 });
    }
    filter = { kind: "boolean", value: raw === "true" };
  }

  const sortRaw = p.get("sort");
  const limitRaw = Number(p.get("limit") ?? "100");

  try {
    const results = await service.facet(params.attributeKey, filter, {
      entityType,
      sort: sortRaw === "desc" ? "desc" : "asc",
      limit: Number.isFinite(limitRaw) ? limitRaw : 100,
    });
    return json(
      {
        data: results,
        meta: { attributeKey: params.attributeKey, count: results.length },
      },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Facet failed" },
      { status: 400 },
    );
  }
};
