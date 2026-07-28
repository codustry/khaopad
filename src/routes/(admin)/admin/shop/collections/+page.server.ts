import { redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) throw redirect(302, "/admin");
  return {};
};
