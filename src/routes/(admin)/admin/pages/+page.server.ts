import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { seedLegalPages } from "$lib/server/content/legal-seed";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage pages.");
  }
  let pages = await locals.content.listPages();

  // PageFilter has no `search` — filter here instead. A site has a
  // handful of pages (About, Contact, legal…), so an in-memory
  // substring match over the loaded list is fine.
  const search = url.searchParams.get("q")?.trim();
  if (search) {
    const needle = search.toLowerCase();
    pages = pages.filter((p) => {
      const titles = Object.values(p.localizations).map((l) => l?.title);
      return [p.slug, ...titles].some((s) => s?.toLowerCase().includes(needle));
    });
  }
  return { pages, search: search ?? "" };
};

export const actions: Actions = {
  seedLegal: async ({ locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!canManageTaxonomy(locals.user))
      return fail(403, { error: "Forbidden" });
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
