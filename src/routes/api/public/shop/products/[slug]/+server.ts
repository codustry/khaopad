/**
 * GET /api/public/shop/products/[slug] — public product detail.
 *
 * Returns the full product graph (localizations, options + values,
 * variants with computed inventory) for headless consumers. Only
 * status='active' products resolve; anything else is a 404.
 */
import { error, json } from "@sveltejs/kit";
import { ShopService } from "$plugins/shop/service";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, params }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const svc = new ShopService(env.DB);
  const product = await svc.getProductBySlug(params.slug);
  if (!product || product.status !== "active") {
    throw error(404, "Product not found");
  }

  // Public shape — filter out archived variants and any internal
  // cost data; keep only what a storefront actually needs.
  const activeVariants = product.variants.filter((v) => v.status === "active");

  return json(
    {
      slug: product.slug,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags ? JSON.parse(product.tags) : [],
      featuredMediaId: product.featuredMediaId,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      publishedAt: product.publishedAt,
      localizations: product.localizations,
      options: product.options.map((o) => ({
        id: o.id,
        name: o.name,
        position: o.position,
        values: o.values.map((v) => ({
          id: v.id,
          value: v.value,
          sortOrder: v.sortOrder,
          swatchHex: v.swatchHex,
        })),
      })),
      variants: activeVariants.map((v) => ({
        id: v.id,
        sku: v.sku,
        titleCached: v.titleCached,
        priceSatang: v.priceSatang,
        compareAtSatang: v.compareAtSatang,
        weightGrams: v.weightGrams,
        requiresShipping: v.requiresShipping,
        taxable: v.taxable,
        mediaId: v.mediaId,
        optionValueIds: v.optionValueIds,
        // Inventory: onHand + reserved intentionally omitted from the
        // public API — reveals ops data. Only "available" (as a bool)
        // and "count" (when >10, exact number would leak stock signal).
        // Clamp to 0 before masking: continue-selling variants can go
        // negative (available = on_hand - reserved past on_hand); a
        // negative stockCount in the public payload leaks that state.
        inStock: (v.inventory?.available ?? 0) > 0,
        stockCount: (() => {
          const raw = v.inventory?.available ?? 0;
          const clamped = Math.max(0, raw);
          return clamped > 10 ? null : clamped;
        })(),
      })),
    },
    {
      headers: {
        "cache-control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
      },
    },
  );
};
