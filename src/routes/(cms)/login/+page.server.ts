import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // If already logged in, redirect to dashboard
  if (locals.user) {
    throw redirect(302, "/dashboard");
  }

  return {};
};
