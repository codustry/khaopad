/**
 * /admin/reviews — moderation queue for @khaopad/plugin-reviews
 * (#160 D2). Editor+ (same trust level as comment moderation).
 *
 * Approve fires the `review.approved` webhook through the core
 * dispatcher; both transitions are audit-logged with the open-string
 * actions "review.approve" / "review.reject" (AuditAction widening).
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { dispatchEvent } from "$lib/server/webhooks";
import { ReviewService } from "$plugins/reviews/service";
import { ShopService } from "$plugins/shop/service";
import type { ReviewStatus } from "$plugins/reviews/schema";
import type { Actions, PageServerLoad } from "./$types";

const PAGE_SIZE = 50;
const VALID_STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];

export const load: PageServerLoad = async ({ locals, url, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can moderate reviews.");
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const statusParam = url.searchParams.get("status") ?? "pending";
  const status: ReviewStatus = (VALID_STATUSES as string[]).includes(
    statusParam,
  )
    ? (statusParam as ReviewStatus)
    : "pending";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  const svc = new ReviewService(env.DB);
  const rows = await svc.listByStatus(status, {
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });
  const hasNext = rows.length > PAGE_SIZE;
  const items = rows.slice(0, PAGE_SIZE);

  // Resolve product ids → slug/title for row labels, de-duped.
  const shop = new ShopService(env.DB);
  const productIds = [...new Set(items.map((r) => r.productId))];
  const products = await Promise.all(
    productIds.map((id) => shop.getProduct(id).catch(() => null)),
  );
  const productById: Record<string, { slug: string; title: string }> = {};
  for (const p of products) {
    if (!p) continue;
    productById[p.id] = {
      slug: p.slug,
      title: p.localizations.en?.title ?? p.localizations.th?.title ?? p.slug,
    };
  }

  const pendingCount = await svc.countByStatus("pending");

  return {
    items,
    productById,
    status,
    page,
    hasPrev: page > 1,
    hasNext,
    pendingCount,
  };
};

export const actions: Actions = {
  setStatus: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    const next = String(fd.get("status") ?? "") as ReviewStatus;
    if (!id || !["approved", "rejected", "pending"].includes(next)) {
      return fail(400, { error: "Bad request" });
    }

    const svc = new ReviewService(env.DB);
    const before = await svc.getReview(id);
    if (!before) return fail(404, { error: "Review not found" });

    await svc.setStatus(id, next);

    await logAudit(
      env.DB,
      locals.user.id,
      next === "approved"
        ? "review.approve"
        : next === "rejected"
          ? "review.reject"
          : "review.create",
      id,
      { productId: before.productId, from: before.status, to: next },
    );

    // Fire the plugin's webhook event only on approve — the moment a
    // review becomes public. Payload carries no reviewer PII beyond
    // what the storefront already shows.
    if (next === "approved") {
      void dispatchEvent(locals.content, {
        event: "review.approved",
        payload: {
          reviewId: id,
          productId: before.productId,
          rating: before.rating,
          verified: before.verified === 1,
        },
      });
    }
    return { ok: true };
  },
};
