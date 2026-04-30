import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { slugify } from "$lib/utils";
import type { NavigationItemKind } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

/**
 * `/cms/navigation` — manage site-wide menus.
 *
 * Editor+ can manage. The page bootstraps the two stock menus
 * (`primary`, `footer`) on first load if they don't exist yet, so a
 * fresh install always has something to point at.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage navigation.");
  }

  let menus = await locals.content.listMenus();
  // First-run bootstrap: ensure primary + footer exist.
  if (!menus.find((m) => m.key === "primary")) {
    await locals.content.createMenu({ key: "primary", label: "Primary" });
  }
  if (!menus.find((m) => m.key === "footer")) {
    await locals.content.createMenu({ key: "footer", label: "Footer" });
  }
  menus = await locals.content.listMenus();

  // Pages, articles, categories, tags — surfaced for the picker so
  // editors can wire any of them as menu items without typing IDs.
  const [pages, articles, categories, tags] = await Promise.all([
    locals.content.listPages({ status: "published" }),
    locals.content.listArticles({ status: "published", limit: 50 }),
    locals.content.listCategories(),
    locals.content.listTags(),
  ]);

  return {
    menus,
    targets: {
      pages: pages.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.localizations.en?.title ?? p.slug,
      })),
      articles: articles.items.map((a) => ({
        id: a.id,
        slug: a.slug,
        title: a.localizations.en?.title ?? a.slug,
      })),
      categories: categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.localizations.en?.name ?? c.slug,
      })),
      tags: tags.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.localizations.en?.name ?? t.slug,
      })),
    },
  };
};

export const actions: Actions = {
  createMenu: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) return fail(403, { error: "Forbidden" });
    const form = await request.formData();
    const label = String(form.get("label") ?? "").trim();
    const keyRaw = String(form.get("key") ?? "").trim();
    const key = slugify(keyRaw || label);
    if (!key || !label) return fail(400, { error: "Key and label are required" });
    const existing = await locals.content.getMenuByKey(key);
    if (existing) return fail(400, { error: `Menu "${key}" already exists` });
    const menu = await locals.content.createMenu({ key, label });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        menu.id,
        { kind: "menu.create", key, label },
      );
    }
    return { ok: true, menuId: menu.id };
  },

  deleteMenu: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) return fail(403, { error: "Forbidden" });
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing menu id" });
    await locals.content.deleteMenu(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "menu.delete" },
      );
    }
    return { ok: true };
  },

  addItem: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) return fail(403, { error: "Forbidden" });
    const form = await request.formData();
    const menuId = String(form.get("menu_id") ?? "").trim();
    const labelEn = String(form.get("label_en") ?? "").trim();
    const labelTh = String(form.get("label_th") ?? "").trim();
    const kind = String(form.get("kind") ?? "custom") as NavigationItemKind;
    const targetId = String(form.get("target_id") ?? "").trim() || null;
    const customUrl = String(form.get("custom_url") ?? "").trim() || null;
    if (!menuId || !labelEn) {
      return fail(400, { error: "Menu and EN label are required" });
    }
    if (kind === "custom" && !customUrl) {
      return fail(400, { error: "Custom URL is required for custom items" });
    }
    if (kind !== "custom" && !targetId) {
      return fail(400, { error: "Pick a target for this item" });
    }
    // Position: append at the end of the menu's top-level items.
    const menus = await locals.content.listMenus();
    const menu = menus.find((m) => m.id === menuId);
    const topLevel = menu?.items.filter((it) => !it.parentId) ?? [];
    const position = topLevel.length;
    const item = await locals.content.createNavigationItem({
      menuId,
      labels: { en: labelEn, ...(labelTh ? { th: labelTh } : {}) },
      kind,
      targetId: kind === "custom" ? null : targetId,
      customUrl: kind === "custom" ? customUrl : null,
      position,
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        item.id,
        { kind: "nav_item.create", menuId, labelEn },
      );
    }
    return { ok: true };
  },

  deleteItem: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) return fail(403, { error: "Forbidden" });
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing item id" });
    await locals.content.deleteNavigationItem(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "nav_item.delete" },
      );
    }
    return { ok: true };
  },

  moveItem: async ({ request, locals }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) return fail(403, { error: "Forbidden" });
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    const direction = String(form.get("direction") ?? "");
    if (!id || !["up", "down"].includes(direction)) {
      return fail(400, { error: "Bad request" });
    }
    // Reorder by swapping positions with the neighbor.
    const menus = await locals.content.listMenus();
    let menu;
    let item;
    for (const mn of menus) {
      const it = mn.items.find((x) => x.id === id);
      if (it) {
        menu = mn;
        item = it;
        break;
      }
    }
    if (!menu || !item) return fail(404, { error: "Item not found" });
    const siblings = menu.items
      .filter((x) => (x.parentId ?? null) === (item.parentId ?? null))
      .sort((a, b) => a.position - b.position);
    const idx = siblings.findIndex((x) => x.id === item.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) {
      return { ok: true }; // already at the edge
    }
    const neighbor = siblings[swapIdx];
    await locals.content.reorderNavigationItems(menu.id, [
      { id: item.id, position: neighbor.position, parentId: item.parentId },
      { id: neighbor.id, position: item.position, parentId: neighbor.parentId },
    ]);
    return { ok: true };
  },
};
