import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  // Allow login page without auth
  if (url.pathname === "/login") {
    return { user: locals.user };
  }

  // Redirect to login if not authenticated
  if (!locals.user) {
    throw redirect(302, "/login");
  }

  return {
    user: locals.user,
  };
};
