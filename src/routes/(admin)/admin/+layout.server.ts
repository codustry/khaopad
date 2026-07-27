import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  // Routes that render their own layout (no sidebar) and don't require auth.
  const PUBLIC_CMS_PATHS = ["/admin/login", "/admin/signup"];
  const isPublicCms =
    PUBLIC_CMS_PATHS.includes(url.pathname) ||
    url.pathname.startsWith("/admin/invite/");

  if (isPublicCms) {
    return { user: locals.user };
  }

  // Redirect to login if not authenticated
  if (!locals.user) {
    throw redirect(302, "/admin/login");
  }

  return {
    user: locals.user,
  };
};
