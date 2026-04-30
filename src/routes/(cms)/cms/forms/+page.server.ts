import { error, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage forms.");
  }
  const forms = await locals.content.listForms();
  return { forms };
};
