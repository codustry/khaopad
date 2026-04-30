import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole, canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import type { Actions, PageServerLoad } from "./$types";

/**
 * `/cms/media` — list view, optionally filtered by folder via `?folder=<id>`
 * (the literal string `root` means "no folder"). v1.7 adds a folder tree
 * with create/rename/delete + drag-to-move. The upload endpoint
 * (`/api/media`) accepts an optional `folderId` form field that the
 * client passes when uploading inside a folder.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(302, "/cms/login");

  const folderParam = url.searchParams.get("folder");
  /** undefined = "all"; null = root; '<id>' = that folder. */
  const folderId =
    folderParam === null
      ? undefined
      : folderParam === "root" || folderParam === ""
        ? null
        : folderParam;

  const [items, folders] = await Promise.all([
    locals.media.list({ folderId }),
    locals.media.listFolders(),
  ]);

  return {
    items,
    folders,
    activeFolderId: folderId ?? null,
    isFiltered: folderParam !== null,
  };
};

export const actions: Actions = {
  delete: async ({ request, locals, platform }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!hasRole(locals.user, "admin")) throw error(403, "Forbidden");

    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });

    const record = await locals.media.get(id);
    if (!record) return fail(404, { error: "Not found" });

    await locals.media.delete(id);
    if (platform?.env?.DB) {
      await logAudit(platform.env.DB, locals.user.id, "media.delete", id, {
        filename: record.filename,
      });
    }
    return { ok: true };
  },

  // ─── Folders (v1.7) ──────────────────────────────────
  // Editor+ can manage folders (same gate as taxonomy).
  createFolder: async ({ request, locals, platform }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!canManageTaxonomy(locals.user)) throw error(403, "Forbidden");
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const parentId = String(form.get("parent_id") ?? "").trim() || null;
    if (!name) return fail(400, { error: "Folder name is required" });
    const folder = await locals.media.createFolder({ name, parentId });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        folder.id,
        { kind: "media_folder.create", name },
      );
    }
    return { ok: true, folderId: folder.id };
  },

  renameFolder: async ({ request, locals, platform }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!canManageTaxonomy(locals.user)) throw error(403, "Forbidden");
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    if (!id || !name) return fail(400, { error: "Missing fields" });
    await locals.media.renameFolder(id, name);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "media_folder.rename", name },
      );
    }
    return { ok: true };
  },

  deleteFolder: async ({ request, locals, platform }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!canManageTaxonomy(locals.user)) throw error(403, "Forbidden");
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing folder id" });
    await locals.media.deleteFolder(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "media_folder.delete" },
      );
    }
    return { ok: true };
  },

  /** Move a media row to a different folder (or to root with folder_id=""). */
  moveMedia: async ({ request, locals }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!canManageTaxonomy(locals.user)) throw error(403, "Forbidden");
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    const folderRaw = String(form.get("folder_id") ?? "").trim();
    const folderId = folderRaw === "" ? null : folderRaw;
    if (!id) return fail(400, { error: "Missing media id" });
    await locals.media.move(id, folderId);
    return { ok: true };
  },
};
