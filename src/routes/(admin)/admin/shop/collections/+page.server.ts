import { redirect, error, fail } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { ShopService, ShopValidationError } from "$plugins/shop/service";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform }) => {
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
  const locale = locals.locale ?? "en";

  // Products are loaded so a collection can be POPULATED at creation
  // time. Without them the page could only ever create empty
  // collections, which is the less useful half of the feature.
  const [collections, products] = await Promise.all([
    svc.listCollectionsForAdmin(locale),
    svc.listProducts({ limit: 200 }),
  ]);

  return { collections, products };
};

export const actions: Actions = {
  create: async ({ request, locals, platform }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!hasRole(locals.user, "editor")) {
      throw error(403, "Only editors and above can create collections.");
    }
    const form = await request.formData();
    const titleEn = String(form.get("titleEn") ?? "").trim();
    const titleTh = String(form.get("titleTh") ?? "").trim();
    const slug = String(form.get("slug") ?? "").trim();
    const status = String(form.get("status") ?? "draft") as
      | "draft"
      | "active"
      | "archived";
    const productIds = form.getAll("productIds").map(String).filter(Boolean);

    const env = platform?.env;
    if (!env) {
      return fail(503, {
        error: "Platform not ready",
        values: { titleEn, titleTh, slug, status },
      });
    }

    // English is required because the slug derives from it —
    // `createCollection` rejects a missing `en` localization. Checking
    // here gives a field-level message instead of a 500.
    if (!titleEn) {
      return fail(400, {
        error: "English title is required — the slug is derived from it.",
        values: { titleEn, titleTh, slug, status },
      });
    }

    const svc = new ShopService(env.DB);
    let id: string;
    try {
      id = await svc.createCollection({
        slug: slug || undefined,
        status,
        localizations: {
          en: { title: titleEn },
          ...(titleTh ? { th: { title: titleTh } } : {}),
        },
        productIds,
      });
    } catch (err) {
      if (err instanceof ShopValidationError) {
        return fail(400, {
          error: err.message,
          values: { titleEn, titleTh, slug, status },
        });
      }
      throw err;
    }

    await logAudit(env.DB, locals.user.id, "shop.collection.create", id, {
      productCount: productIds.length,
    });

    return { success: true, id };
  },
};
