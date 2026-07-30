/**
 * /admin/shop/products — product list.
 *
 * Editor+ can view/list/edit; only admins can delete or archive.
 * Product list shows title (English localization), current status,
 * price-from (min variant price), and in-stock badge.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { ShopService } from "$plugins/shop/service";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, url }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw redirect(302, "/admin");
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const svc = new ShopService(env.DB);
  const statusFilter = url.searchParams.get("status") as
    | "draft"
    | "active"
    | "archived"
    | null;
  const products = await svc.listProducts({
    status: statusFilter ?? undefined,
    limit: 100,
  });
  return { products, statusFilter };
};

export const actions: Actions = {
  archive: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "");
    if (!id) return fail(400, { error: "Missing id" });
    const svc = new ShopService(env.DB);
    await svc.updateProductStatus(id, "archived");
    await logAudit(env.DB, locals.user.id, "product.updated", id, {
      change: "archived",
    });
    return { success: true };
  },
  delete: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "");
    if (!id) return fail(400, { error: "Missing id" });
    const svc = new ShopService(env.DB);
    await svc.deleteProduct(id);
    await logAudit(env.DB, locals.user.id, "product.deleted", id, {});
    return { success: true };
  },
};
