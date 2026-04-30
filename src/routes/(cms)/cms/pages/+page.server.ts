import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { seedLegalPages } from "$lib/server/content/legal-seed";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage pages.");
  }
  const pages = await locals.content.listPages();
  return { pages };
};

export const actions: Actions = {
  seedLegal: async ({ locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) return fail(403, { error: "Forbidden" });
    const result = await seedLegalPages(locals.content, locals.user.id);
    if (platform?.env?.DB) {
      for (const p of result.created) {
        await logAudit(
          platform.env.DB,
          locals.user.id,
          "settings.update",
          p.id,
          { kind: "page.seed_legal", slug: p.slug },
        );
      }
    }
    return {
      ok: true,
      seeded: result.created.map((p) => ({ id: p.id, slug: p.slug })),
      skipped: result.skipped,
    };
  },
};
