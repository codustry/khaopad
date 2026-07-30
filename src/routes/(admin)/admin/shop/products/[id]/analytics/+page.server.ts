/**
 * /admin/shop/products/[id]/analytics — per-product dashboard.
 *
 * Editor+. Shows product_view, add_to_cart, purchase counts +
 * conversion rates over a 30-day window.
 */
import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { getProductAnalytics } from "$lib/server/analytics/aggregate";
import { ShopService } from "$plugins/shop/service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) throw redirect(302, "/admin");
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const svc = new ShopService(env.DB);
  const product = await svc.getProduct(params.id);
  if (!product) throw error(404, "Product not found");
  const enTitle = product.localizations?.en?.title ?? product.slug ?? params.id;
  const analytics = await getProductAnalytics(env.DB, params.id, 30);
  return {
    productId: params.id,
    productTitle: enTitle,
    productSlug: product.slug,
    analytics,
  };
};
