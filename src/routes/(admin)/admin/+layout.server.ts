import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { getEnabledPlugins } from "$lib/server/plugins/enabled";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, url }) => {
  // Routes that render their own layout (no sidebar) and don't require auth.
  const PUBLIC_CMS_PATHS = ["/admin/login", "/admin/signup"];
  const isPublicCms =
    PUBLIC_CMS_PATHS.includes(url.pathname) ||
    url.pathname.startsWith("/admin/invite/");

  if (isPublicCms) {
    // Login/signup render without the shell, so they need no nav gate —
    // and skipping the settings read keeps the unauthenticated path off
    // the database.
    return { user: locals.user, enabledPlugins: [] };
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

  // #193: the opt-in plugin set, resolved ONCE per admin navigation and
  // handed to the sidebar + command palette.
  //
  // Why here rather than at registration time: nav registration runs at
  // module load in both bundles and cannot await D1. Passing the set
  // down as layout data is what keeps SSR and hydration in agreement —
  // the client filters the same static registry with the same array
  // that rendered the server HTML, so there is no flash of a nav group
  // that is about to disappear, and no hydration mismatch.
  return {
    user: locals.user,
    enabledPlugins: await getEnabledPlugins(locals.content),
  };
};
