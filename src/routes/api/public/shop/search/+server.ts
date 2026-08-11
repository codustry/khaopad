/**
 * GET /api/public/shop/search — as-you-type product search.
 *
 * Backs the (www) header search dropdown. Unauthenticated, like the
 * other /api/public/shop endpoints.
 *
 * Query params:
 *   q=<string>  — search term. Under 2 characters returns an empty
 *     result set (200, not 400 — the client debounces keystrokes and
 *     an error state per keystroke would be noise). 2 chars runs the
 *     LIKE fallback; 3+ runs trigram FTS (see $plugins/shop/search).
 *   locale=en|th (fallback en) — locale for result titles.
 *
 * Results are capped at 8 — this is a typeahead, not a results page;
 * /[locale]/search?q= is the full surface.
 *
 * Cache: short public TTL (30s). Search-as-you-type tolerates 30s of
 * staleness fine and the shared cache absorbs repeated keystrokes
 * across visitors; debounce lives client-side.
 */
import { json, error } from "@sveltejs/kit";
import { toLocale } from "$lib/i18n";
import { drizzle } from "drizzle-orm/d1";
import { searchProducts, MIN_QUERY_LENGTH } from "$plugins/shop/search";
import type { RequestHandler } from "./$types";

const RESULT_CAP = 8;

export const GET: RequestHandler = async ({ platform, url }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const locale = toLocale(url.searchParams.get("locale") ?? "en");
  const q = (url.searchParams.get("q") ?? "").trim();

  const results =
    q.length >= MIN_QUERY_LENGTH
      ? await searchProducts(drizzle(env.DB), {
          query: q,
          locale,
          limit: RESULT_CAP,
        })
      : [];

  return json(
    {
      query: q,
      locale,
      results: results.map((r) => ({
        slug: r.slug,
        title: r.title,
        priceFromSatang: r.priceFromSatang,
      })),
    },
    {
      headers: {
        "cache-control": "public, max-age=30",
      },
    },
  );
};
