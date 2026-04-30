import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { slugify } from "$lib/utils";
import type { Actions, PageServerLoad } from "./$types";

/**
 * `/cms/blocks` — list, create, update, delete reusable content blocks.
 *
 * Any editor+ can manage. Authors can't (taxonomy-level permission gate
 * is the right fit: blocks are author-facing snippets shared across
 * articles, not content owned by a single author).
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can manage content blocks.");
  }
  const blocks = await locals.content.listContentBlocks();
  return { blocks };
};

export const actions: Actions = {
  create: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const form = await request.formData();
    const keyRaw = String(form.get("key") ?? "").trim();
    const label = String(form.get("label") ?? "").trim();
    const bodyEn = String(form.get("body_en") ?? "");
    const bodyTh = String(form.get("body_th") ?? "");

    const key = slugify(keyRaw);
    if (!key || !label) {
      return fail(400, { error: "Key and label are required." });
    }

    const existing = await locals.content.getContentBlockByKey(key);
    if (existing) {
      return fail(400, { error: `A block with key "${key}" already exists.` });
    }

    const block = await locals.content.createContentBlock({
      key,
      label,
      localizations: {
        en: { body: bodyEn },
        ...(bodyTh ? { th: { body: bodyTh } } : {}),
      },
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        block.id,
        { kind: "content_block.create", key: block.key, label: block.label },
      );
    }
    return { ok: true, blockId: block.id };
  },

  update: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    const keyRaw = String(form.get("key") ?? "").trim();
    const label = String(form.get("label") ?? "").trim();
    const bodyEn = String(form.get("body_en") ?? "");
    const bodyTh = String(form.get("body_th") ?? "");
    const key = slugify(keyRaw);

    if (!id || !key || !label) {
      return fail(400, { error: "Missing required fields." });
    }
    const existing = await locals.content.getContentBlock(id);
    if (!existing) return fail(404, { error: "Block not found" });

    // If the key changed, make sure the new one is free.
    if (key !== existing.key) {
      const conflict = await locals.content.getContentBlockByKey(key);
      if (conflict) {
        return fail(400, { error: `Key "${key}" is already taken.` });
      }
    }

    const block = await locals.content.updateContentBlock(id, {
      key,
      label,
      localizations: {
        en: { body: bodyEn },
        ...(bodyTh ? { th: { body: bodyTh } } : {}),
      },
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        block.id,
        { kind: "content_block.update", key: block.key },
      );
    }
    return { ok: true };
  },

  delete: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing block id" });
    const existing = await locals.content.getContentBlock(id);
    if (!existing) return fail(404, { error: "Block not found" });
    await locals.content.deleteContentBlock(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "content_block.delete", key: existing.key },
      );
    }
    return { ok: true };
  },
};
