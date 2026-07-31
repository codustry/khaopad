import { redirect, error } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw error(
      403,
      "Only editors, admins and super admins can access this area.",
    );
  }
  return {};
};
