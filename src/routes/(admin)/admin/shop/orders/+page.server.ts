/**
 * /admin/shop/orders — admin order list.
 *
 * Admin+ only. Lists orders with status filter tabs, quick summary
 * (customer email, total, status badge). Click through to per-order
 * detail page for lifecycle actions.
 */
import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { OrderService } from "$plugins/shop/order-service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, url }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "admin")) {
    throw error(403, "Only admins and super admins can access this area.");
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const svc = new OrderService(env.DB);
  const statusFilter = url.searchParams.get("status") as
    | "pending"
    | "paid"
    | "fulfilled"
    | "delivered"
    | "refunded"
    | "cancelled"
    | null;
  const orders = await svc.listOrders({
    status: statusFilter ?? undefined,
    limit: 100,
  });
  return { orders, statusFilter };
};
