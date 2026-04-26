import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  const items = await locals.media.list();
  return { items };
};

export const actions: Actions = {
  delete: async ({ request, locals }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!hasRole(locals.user, "admin")) throw error(403, "Forbidden");

    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return { ok: false, error: "Missing id" };

    const record = await locals.media.get(id);
    if (!record) return { ok: false, error: "Not found" };

    await locals.media.delete(id);
    return { ok: true };
  },
};
