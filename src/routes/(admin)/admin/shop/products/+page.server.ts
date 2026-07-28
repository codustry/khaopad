/**
 * /admin/shop/products — placeholder for v3.1 product catalog.
 *
 * The real product list ships in a follow-up sub-PR (2b/2c) with the
 * 7-table schema + CRUD editor. For now this just proves the route
 * mount works end-to-end from the plugin skeleton.
 */
import { redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw redirect(302, "/admin");
  }
  return {};
};
