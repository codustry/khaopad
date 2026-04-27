import { redirect } from "@sveltejs/kit";
import { hasAnySuperAdmin } from "$lib/server/auth/bootstrap";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform }) => {
  // If already logged in, redirect to dashboard
  if (locals.user) {
    throw redirect(302, "/cms/dashboard");
  }

  const bootstrapNeeded =
    locals.platformReady && platform?.env
      ? !(await hasAnySuperAdmin(platform.env.DB))
      : false;

  return { bootstrapNeeded };
};
