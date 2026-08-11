/**
 * /admin/shop/products/[id] — product editor.
 *
 * v3.16 (#160 C3): a real editor. Alongside the v3.1 actions (status
 * toggle, inventory adjust, delete) the page now saves per-locale
 * title/description, vendor/product-type, and per-variant
 * price/compare-at/SKU through one `?/save` action wired to the
 * shared SaveBar + DirtyState pattern (see ArticleForm.svelte).
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { ShopService, ShopValidationError } from "$plugins/shop/service";
import { notifyBackInStock } from "$plugins/shop/back-in-stock";
import { parseBahtToSatang } from "$plugins/shop/money";
import { dispatchEvent } from "$lib/server/webhooks";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw error(
      403,
      "Only editors, admins and super admins can access this area.",
    );
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const svc = new ShopService(env.DB);
  const product = await svc.getProduct(params.id);
  if (!product) throw error(404, "Product not found");
  return { product };
};

export const actions: Actions = {
  save: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const titleEn = String(fd.get("title_en") ?? "").trim();
    const descEn = String(fd.get("description_en") ?? "").trim();
    const titleTh = String(fd.get("title_th") ?? "").trim();
    const descTh = String(fd.get("description_th") ?? "").trim();
    const vendor = String(fd.get("vendor") ?? "").trim();
    const productType = String(fd.get("product_type") ?? "").trim();

    if (!titleEn) {
      return fail(400, {
        error: "English title is required",
        field: "title_en",
      });
    }

    // Per-variant fields arrive as variant_<id>_price / _compare_at /
    // _sku. Collect ids from the price keys (always submitted per row).
    const variantIds: string[] = [];
    for (const key of fd.keys()) {
      const match = /^variant_(.+)_price$/.exec(key);
      if (match) variantIds.push(match[1]);
    }
    const variantUpdates: Array<{
      id: string;
      priceSatang: number;
      compareAtSatang: number | null;
      sku: string | null;
    }> = [];
    for (const id of variantIds) {
      const priceInput = String(fd.get(`variant_${id}_price`) ?? "").trim();
      const compareInput = String(
        fd.get(`variant_${id}_compare_at`) ?? "",
      ).trim();
      const sku = String(fd.get(`variant_${id}_sku`) ?? "").trim();
      const priceSatang = parseBahtToSatang(priceInput);
      if (priceSatang === null) {
        return fail(400, {
          error: `Variant price must be a positive number (e.g. 199.50)`,
          field: `variant_${id}_price`,
        });
      }
      let compareAtSatang: number | null = null;
      if (compareInput) {
        compareAtSatang = parseBahtToSatang(compareInput);
        if (compareAtSatang === null) {
          return fail(400, {
            error: `Compare-at price must be a positive number`,
            field: `variant_${id}_compare_at`,
          });
        }
      }
      variantUpdates.push({
        id,
        priceSatang,
        compareAtSatang,
        sku: sku || null,
      });
    }

    const svc = new ShopService(env.DB);
    try {
      await svc.updateProduct(params.id, {
        vendor: vendor || null,
        productType: productType || null,
      });
      // upsertLocalization refreshes products_fts after each write —
      // the reason edited titles don't go stale in search (#160 A3).
      await svc.upsertLocalization(params.id, "en", {
        title: titleEn,
        descriptionMarkdown: descEn || null,
      });
      await svc.upsertLocalization(params.id, "th", {
        title: titleTh,
        descriptionMarkdown: descTh || null,
      });
      for (const v of variantUpdates) {
        await svc.updateVariant(v.id, {
          priceSatang: v.priceSatang,
          compareAtSatang: v.compareAtSatang,
          sku: v.sku,
        });
      }
    } catch (err) {
      if (err instanceof ShopValidationError) {
        return fail(400, { error: err.message, field: err.field });
      }
      throw err;
    }

    await logAudit(env.DB, locals.user.id, "product.updated", params.id, {
      change: "content",
      title: titleEn,
      variantCount: variantUpdates.length,
    });
    void dispatchEvent(locals.content, {
      event: "product.updated",
      payload: { id: params.id, change: "content" },
    });
    return { success: true, message: "Product saved" };
  },

  setStatus: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor"))
      return fail(403, { error: "Forbidden" });
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
    // #113: product.updated was registered at plugin boot but never
    // fired — emit on the write path (fire-and-forget).
    void dispatchEvent(locals.content, {
      event: "product.updated",
      payload: { id: params.id, change: "status", status },
    });
    return { success: true, message: `Status changed to ${status}` };
  },

  adjustInventory: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor"))
      return fail(403, { error: "Forbidden" });
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
      await logAudit(env.DB, locals.user.id, "inventory.adjusted", variantId, {
        delta,
        productId: params.id,
        newOnHand: result.onHand,
      });
      // Back-in-stock notify (v3.17 D4): fire on any on_hand INCREASE.
      // Fire-and-forget — restock mail is best-effort and must never
      // delay or fail the admin's stock adjustment.
      if (delta > 0) {
        void notifyBackInStock(env, env.DB, variantId);
      }
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
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const svc = new ShopService(env.DB);
    await svc.deleteProduct(params.id);
    await logAudit(env.DB, locals.user.id, "product.deleted", params.id, {});
    throw redirect(303, "/admin/shop/products");
  },
};
