import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  // Allow login and the one-shot signup page without auth
  if (url.pathname === "/login" || url.pathname === "/signup") {
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
