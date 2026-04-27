import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/**
 * Bare `/cms` has no content of its own — it's just the prefix for the
 * admin surface. Send authenticated users to the dashboard, everyone else
 * to the login page. The auth state is already resolved on locals by the
 * (cms) layout.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) throw redirect(302, "/cms/dashboard");
  throw redirect(302, "/cms/login");
};
