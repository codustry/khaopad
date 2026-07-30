/**
 * /admin/shop/discounts — discount code CRUD.
 *
 * Admin+ only. Lists all codes with active/inactive badges, redemption
 * counts. New-code form is inline (kind picker + value input + limits).
 *
 * v3.5 MVP: no per-code detail page — everything happens on this
 * single page. Detail page ships when discount analytics need their
 * own home in v3.6+.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { drizzle } from "drizzle-orm/d1";
import { count, eq } from "drizzle-orm";
import { createDiscount, listDiscounts } from "$plugins/shop/discount-service";
import {
  shopDiscountCodes,
  shopDiscountRedemptions,
} from "$plugins/shop/schema-discount";
import { parseBahtToSatang } from "$plugins/shop/money";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "admin")) throw redirect(302, "/admin");
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const codes = await listDiscounts(env.DB);
  // Redemption counts per code — one query for all.
  const db = drizzle(env.DB);
  const counts = await db
    .select({
      discountId: shopDiscountRedemptions.discountId,
      total: count(),
    })
    .from(shopDiscountRedemptions)
    .groupBy(shopDiscountRedemptions.discountId)
    .all();
  const countByDiscount = new Map(counts.map((c) => [c.discountId, c.total]));

  return {
    codes: codes.map((c) => ({
      id: c.id,
      code: c.code,
      kind: c.kind,
      valueSatang: c.valueSatang,
      valuePercent: c.valuePercent,
      maxRedemptions: c.maxRedemptions,
      maxPerCustomer: c.maxPerCustomer,
      minOrderSatang: c.minOrderSatang,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      active: c.active,
      description: c.description,
      redemptions: countByDiscount.get(c.id) ?? 0,
    })),
  };
};

export const actions: Actions = {
  create: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin")) {
      return fail(403, { error: "Forbidden" });
    }
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const code = String(fd.get("code") ?? "").trim();
    const kind = String(fd.get("kind") ?? "") as
      | "fixed_satang"
      | "percent"
      | "free_shipping";
    const valueBaht = String(fd.get("value_baht") ?? "").trim();
    const valuePercent = Number(String(fd.get("value_percent") ?? "").trim());
    const maxRedemptions = Number(
      String(fd.get("max_redemptions") ?? "").trim(),
    );
    const maxPerCustomer = Number(
      String(fd.get("max_per_customer") ?? "").trim(),
    );
    const minOrderBaht = String(fd.get("min_order_baht") ?? "").trim();
    const description = String(fd.get("description") ?? "").trim() || null;

    if (!code) return fail(400, { error: "Code is required" });
    if (!["fixed_satang", "percent", "free_shipping"].includes(kind)) {
      return fail(400, { error: "Invalid discount kind" });
    }
    // free_shipping codes stub in v3.5 because the checkout doesn't
    // collect a shipping address yet (shipping is universally 0 until
    // v3.6). Blocking creation here beats silently issuing codes that
    // apply a ฿0 discount at checkout.
    if (kind === "free_shipping") {
      return fail(400, {
        error:
          "free_shipping codes need the v3.6 shipping-address flow — not yet available",
      });
    }
    let valueSatang: number | undefined;
    if (kind === "fixed_satang") {
      const parsed = parseBahtToSatang(valueBaht);
      if (parsed === null || parsed <= 0) {
        return fail(400, { error: "Enter a positive baht amount" });
      }
      valueSatang = parsed;
    }
    if (kind === "percent") {
      if (
        !Number.isFinite(valuePercent) ||
        valuePercent <= 0 ||
        valuePercent > 100
      ) {
        return fail(400, { error: "Percent must be between 0 and 100" });
      }
    }
    const minOrderSatang = minOrderBaht
      ? parseBahtToSatang(minOrderBaht)
      : null;
    if (minOrderBaht && minOrderSatang === null) {
      return fail(400, { error: "Minimum order must be a valid baht amount" });
    }

    try {
      const id = await createDiscount(env.DB, {
        code,
        kind,
        valueSatang,
        valuePercent: kind === "percent" ? valuePercent : undefined,
        maxRedemptions:
          Number.isFinite(maxRedemptions) && maxRedemptions > 0
            ? maxRedemptions
            : null,
        maxPerCustomer:
          Number.isFinite(maxPerCustomer) && maxPerCustomer > 0
            ? maxPerCustomer
            : null,
        minOrderSatang,
        description,
        createdBy: locals.user.id,
      });
      await logAudit(env.DB, locals.user.id, "discount.created", id, { code });
      return { success: true, message: `Created code ${code.toUpperCase()}` };
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to create",
      });
    }
  },

  toggle: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });
    const db = drizzle(env.DB);
    const existing = await db
      .select()
      .from(shopDiscountCodes)
      .where(eq(shopDiscountCodes.id, id))
      .limit(1)
      .get();
    if (!existing) return fail(404, { error: "Not found" });
    await db
      .update(shopDiscountCodes)
      .set({
        active: !existing.active,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(shopDiscountCodes.id, id));
    await logAudit(env.DB, locals.user.id, "discount.updated", id, {
      change: `active → ${!existing.active}`,
    });
    return { success: true };
  },
};
