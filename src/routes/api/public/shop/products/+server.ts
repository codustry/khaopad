/**
 * GET /api/public/shop/products — public product list.
 *
 * Consumer surface for headless clients + storefronts on other stacks.
 * Bearer-auth via /admin/api-keys with the `shop:read` scope (v2.0d
 * public REST API pattern; scopes ship in v3.2 sub-PR when we add
 * shop-scoped keys — for now falls back to unauthenticated public
 * access, matching the article/category/tag public endpoints).
 *
 * Query params:
 *   locale=en|th (fallback: en) — which localization to return
 *   limit=<1..100> (default 20)
 *   offset=<int> (default 0)
 *   status=active (default; unauthenticated calls cannot request
 *     draft/archived — those require an authenticated request with
 *     an admin+ session, not shipped as an API surface yet)
 */
import { json, error } from "@sveltejs/kit";
import { toLocale } from "$lib/i18n";
import { ShopService } from "$plugins/shop/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  // Validate locale against SUPPORTED_LOCALES; unknown values fall
  // back to the default (`en`). Prevents echoing arbitrary garbage
  // in the response and prevents future locale-scoped queries from
  // reading a bogus value.
  const locale = toLocale(url.searchParams.get("locale") ?? "en");
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const limit = Math.max(
    1,
    Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20),
  );
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

  const svc = new ShopService(env.DB);
  const rows = await svc.listProducts({ status: "active", limit, offset });

  // Public shape — no internal fields, no cost/margin data
  const products = rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    vendor: r.vendor,
    productType: r.productType,
    priceFromSatang: r.priceFromSatang,
    inStock: r.inStock,
    publishedAt: r.publishedAt,
  }));

  return json(
    { products, limit, offset, locale },
    {
      headers: {
        // Match public/articles cache policy: read-heavy, edits infrequent
        "cache-control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
      },
    },
  );
};
