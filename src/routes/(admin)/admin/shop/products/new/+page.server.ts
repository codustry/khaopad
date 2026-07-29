/**
 * /admin/shop/products/new — create product form action.
 *
 * v3.1 UX: single-variant products only from the "new" form. Adding
 * options + variants happens on the edit page after creation. This
 * keeps the onboarding path simple; the ADR's variant-matrix editor
 * is more valuable when there's already a product to attach to.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { ShopService, ShopValidationError } from "$plugins/shop/service";
import { parseBahtToSatang, satang } from "$plugins/shop/money";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) throw redirect(302, "/admin");
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor")) {
      return fail(403, { error: "Forbidden" });
    }
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const titleEn = String(fd.get("title_en") ?? "").trim();
    const titleTh = String(fd.get("title_th") ?? "").trim();
    const descEn = String(fd.get("description_en") ?? "").trim();
    const descTh = String(fd.get("description_th") ?? "").trim();
    const priceInput = String(fd.get("price") ?? "").trim();
    const skuInput = String(fd.get("sku") ?? "").trim();
    const status =
      (fd.get("status") as "draft" | "active") ?? "draft";

    if (!titleEn) {
      return fail(400, {
        error: "English title is required",
        field: "title_en",
      });
    }
    const priceSatang = parseBahtToSatang(priceInput);
    if (priceSatang === null) {
      return fail(400, {
        error: "Price must be a positive number (e.g. 199.50)",
        field: "price",
      });
    }
    if (status !== "draft" && status !== "active") {
      return fail(400, { error: "Invalid status" });
    }

    const svc = new ShopService(env.DB);
    try {
      const productId = await svc.createProduct({
        status,
        localizations: {
          en: {
            title: titleEn,
            descriptionMarkdown: descEn || null,
          },
          ...(titleTh
            ? {
                th: {
                  title: titleTh,
                  descriptionMarkdown: descTh || null,
                },
              }
            : {}),
        },
        variants: [
          {
            sku: skuInput || null,
            priceSatang,
            optionValueIds: [], // single default variant, no options yet
            initialOnHand: 0,
          },
        ],
      });
      await logAudit(env.DB, locals.user.id, "product.created", productId, {
        title: titleEn,
      });
      throw redirect(303, `/admin/shop/products/${productId}`);
    } catch (err) {
      if (err instanceof ShopValidationError) {
        return fail(400, { error: err.message, field: err.field });
      }
      throw err;
    }
  },
};
