/**
 * /admin/shop/products/[id] — product editor.
 *
 * v3.1 UX: read-heavy view with three actions:
 *   1. Toggle status (draft ↔ active ↔ archived)
 *   2. Adjust inventory (+/- delta per variant)
 *   3. Delete product
 *
 * Rich metadata editing (title, description, media, SEO, options,
 * variant matrix editor) lands in a follow-up sub-PR — the goal of
 * 2c is to prove the CRUD pipeline works end-to-end with the plugin
 * runtime, not to ship the full Shopify-parity editor.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { ShopService, ShopValidationError } from "$plugins/shop/service";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) throw redirect(302, "/admin");
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const svc = new ShopService(env.DB);
  const product = await svc.getProduct(params.id);
  if (!product) throw error(404, "Product not found");
  return { product };
};

export const actions: Actions = {
  setStatus: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor")) return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const status = String(fd.get("status") ?? "") as
      | "draft"
      | "active"
      | "archived";
    if (!["draft", "active", "archived"].includes(status)) {
      return fail(400, { error: "Invalid status" });
    }
    if (status === "archived" && !hasRole(locals.user, "admin")) {
      return fail(403, { error: "Only admins can archive products" });
    }
    const svc = new ShopService(env.DB);
    await svc.updateProductStatus(params.id, status);
    await logAudit(env.DB, locals.user.id, "product.updated", params.id, {
      change: `status → ${status}`,
    });
    return { success: true, message: `Status changed to ${status}` };
  },

  adjustInventory: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor")) return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const variantId = String(fd.get("variantId") ?? "");
    const delta = Number(fd.get("delta") ?? "0");
    if (!variantId) return fail(400, { error: "Missing variantId" });
    if (!Number.isFinite(delta) || Math.abs(delta) > 1_000_000) {
      return fail(400, { error: "Delta must be a reasonable integer" });
    }
    const svc = new ShopService(env.DB);
    try {
      const result = await svc.adjustInventory(variantId, Math.trunc(delta));
      await logAudit(
        env.DB,
        locals.user.id,
        "inventory.adjusted",
        variantId,
        { delta, productId: params.id, newOnHand: result.onHand },
      );
      return {
        success: true,
        message: `Inventory adjusted (+${delta}, on_hand=${result.onHand})`,
      };
    } catch (err) {
      if (err instanceof ShopValidationError) {
        return fail(400, { error: err.message });
      }
      throw err;
    }
  },

  delete: async ({ locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin")) return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const svc = new ShopService(env.DB);
    await svc.deleteProduct(params.id);
    await logAudit(env.DB, locals.user.id, "product.deleted", params.id, {});
    throw redirect(303, "/admin/shop/products");
  },
};
