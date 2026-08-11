import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
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

  // Staff only (v3.17 D1): customer accounts share the auth stack with
  // the CMS but must never enter it. `author` is the weakest staff
  // role; `customer` ranks below it, so this 403s exactly the shopper
  // sessions minted by the email-OTP sign-in. A hard 403 (not a login
  // redirect) — the customer IS signed in, just not privileged.
  if (!hasRole(locals.user, "author")) {
    throw error(403, "This area is for staff accounts.");
  }

  return {
    user: locals.user,
  };
};
