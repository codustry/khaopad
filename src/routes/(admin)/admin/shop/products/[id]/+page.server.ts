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
  // #165: options for the bundle component picker. Excludes this
  // product's own variants and every bundle product, so the picker
  // cannot offer a choice setBundleComponents would reject.
  const bundleCandidates = await svc.listBundleCandidateVariants(params.id);
  return { product, bundleCandidates };
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

    // ── Bundle components (#165) ──
    // The picker posts parallel arrays: one bundle_component_variant
    // and one bundle_component_qty per row, in DOM order. Blank rows
    // (the merchant added a row but picked nothing) are dropped rather
    // than rejected — an empty select is an unfinished thought, not an
    // error worth blocking a save over.
    const isBundle = fd.get("is_bundle") === "on";
    const componentVariantIds = fd
      .getAll("bundle_component_variant")
      .map((v) => String(v).trim());
    const componentQtys = fd
      .getAll("bundle_component_qty")
      .map((v) => String(v).trim());
    const bundleComponents: Array<{
      componentVariantId: string;
      quantity: number;
    }> = [];
    for (const [i, variantId] of componentVariantIds.entries()) {
      if (!variantId) continue;
      const qty = Number(componentQtys[i] ?? "1");
      if (!Number.isInteger(qty) || qty <= 0 || qty > 10_000) {
        return fail(400, {
          error: "Bundle quantity must be a whole number between 1 and 10,000",
          field: "bundle_component_qty",
        });
      }
      bundleComponents.push({ componentVariantId: variantId, quantity: qty });
    }

    const svc = new ShopService(env.DB);
    const product = await svc.getProduct(params.id);
    if (!product) return fail(404, { error: "Product not found" });
    try {
      await svc.updateProduct(params.id, {
        vendor: vendor || null,
        productType: productType || null,
        isBundle,
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
      // Components hang off the bundle VARIANT, and the editor's picker
      // is per-product, so it targets the product's first variant —
      // the single-variant shape a fixed bundle has in practice. A
      // multi-variant bundle would need a per-variant picker; that is
      // deliberately out of scope for D7 ("a bundle product type
      // referencing component variants at a fixed price").
      //
      // Turning the bundle flag OFF clears the component rows too:
      // leaving them behind would keep the expansion path live for a
      // product the merchant has decided is no longer a bundle.
      const bundleVariantId = product.variants[0]?.id;
      if (bundleVariantId) {
        await svc.setBundleComponents(
          bundleVariantId,
          isBundle ? bundleComponents : [],
        );
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
