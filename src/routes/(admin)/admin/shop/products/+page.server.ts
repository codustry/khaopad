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
import { dispatchEvent } from "$lib/server/webhooks";
import {
  byNumber,
  byString,
  parseSort,
  sortRows,
} from "$lib/server/admin/sort";
import { BULK_MAX_IDS, chunk, parseBulkIds } from "$lib/server/admin/bulk";
import type { Actions, PageServerLoad } from "./$types";

/** Sortable columns (#160 C5). The `sort` param never reaches SQL —
 * it only selects one of these literal comparators. */
const SORTABLE = ["title", "status", "price"] as const;

type ProductRow = Awaited<ReturnType<ShopService["listProducts"]>>[number];

const COMPARATORS = {
  title: byString<ProductRow>((p) => p.title),
  status: byString<ProductRow>((p) => p.status),
  price: byNumber<ProductRow>((p) => p.priceFromSatang),
};

const BULK_OPS = ["activate", "draft", "archive", "delete"] as const;
type BulkOp = (typeof BULK_OPS)[number];

export const load: PageServerLoad = async ({ locals, platform, url }) => {
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
  const statusFilter = url.searchParams.get("status") as
    | "draft"
    | "active"
    | "archived"
    | null;
  let products = await svc.listProducts({
    status: statusFilter ?? undefined,
    limit: 100,
  });

  // ShopService.listProducts has no search option — filter here over
  // the loaded page instead. The admin list is capped at 100 rows, so
  // an in-memory substring match is fine.
  const search = url.searchParams.get("q")?.trim();
  if (search) {
    const needle = search.toLowerCase();
    products = products.filter(
      (p) =>
        p.title.toLowerCase().includes(needle) ||
        p.slug.toLowerCase().includes(needle),
    );
  }
  // Sorting happens over the same in-memory page the search filter
  // already works on (capped at 100 rows) — see $lib/server/admin/sort.
  const { sort, dir } = parseSort(url, SORTABLE);
  products = sortRows(products, COMPARATORS, sort, dir);

  return { products, statusFilter, search: search ?? "", sort, dir };
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
    // #113: fire the registered product.updated event on the write path.
    void dispatchEvent(locals.content, {
      event: "product.updated",
      payload: { id, change: "status", status: "archived" },
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

  /**
   * Bulk status/delete over the checkbox selection (#160 C5).
   *
   * One action, `op` + repeated `ids` fields. Loops the existing
   * single-item service methods in bounded chunks — D1 has no
   * cross-statement transaction, so each id lands independently.
   *
   * Roles mirror the single-item actions: status flips are editor+
   * (product editing is editor+), archive/delete are admin-only.
   * Delete additionally requires `confirmCount` == ids.length, set by
   * the typed-confirm prompt client-side and re-checked here so a
   * hand-rolled POST gets no weaker guarantee.
   */
  bulk: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const op = String(fd.get("op") ?? "") as BulkOp;
    if (!BULK_OPS.includes(op)) return fail(400, { error: "Unknown bulk op" });

    const needsAdmin = op === "archive" || op === "delete";
    if (!hasRole(locals.user, needsAdmin ? "admin" : "editor")) {
      return fail(403, { error: "Forbidden" });
    }

    const ids = parseBulkIds(fd);
    if (ids.length === 0) return fail(400, { error: "No products selected" });
    if (ids.length > BULK_MAX_IDS) {
      return fail(400, {
        error: `At most ${BULK_MAX_IDS} products per bulk action`,
      });
    }

    if (op === "delete") {
      const confirmCount = Number(fd.get("confirmCount"));
      if (confirmCount !== ids.length) {
        return fail(400, { error: "Confirmation count mismatch" });
      }
    }

    const svc = new ShopService(env.DB);
    const status =
      op === "activate" ? "active" : op === "draft" ? "draft" : "archived";

    for (const group of chunk(ids)) {
      await Promise.all(
        group.map(async (id) => {
          if (op === "delete") {
            await svc.deleteProduct(id);
          } else {
            await svc.updateProductStatus(id, status);
            // #113: product.updated fires per id, same as the single
            // archive action.
            void dispatchEvent(locals.content, {
              event: "product.updated",
              payload: { id, change: "status", status },
            });
          }
        }),
      );
    }

    // One audit row per bulk request — per-id rows would drown the
    // activity feed; the full id list lives in the metadata.
    await logAudit(
      env.DB,
      locals.user.id,
      op === "delete" ? "product.deleted" : "product.updated",
      ids[0],
      { bulk: op, count: ids.length, ids },
    );
    return { success: true };
  },
};
