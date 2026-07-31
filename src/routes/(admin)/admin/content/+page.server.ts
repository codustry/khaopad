/**
 * /admin/content — registry collection index — Phase 4 (#68 §F).
 *
 * Lists every user-defined content type with its field and entry counts,
 * and creates new ones. This is the "add a content type without a
 * deploy" surface the whole registry exists to enable.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { drizzle } from "drizzle-orm/d1";
import { count } from "drizzle-orm";
import { createRegistryQuery } from "$lib/server/content/registry";
import { entries } from "$lib/server/content/registry/schema";
import { RegistryError } from "$lib/server/content/registry/types";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  // Defining a content type is a schema change in every meaningful sense
  // — it alters what the public API exposes — so it sits with admins,
  // not editors, matching how /admin/settings is gated.
  if (!hasRole(locals.user, "admin")) {
    throw error(403, "Only admins and super admins can access this area.");
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const registry = createRegistryQuery(env);
  const collections = await registry.service.listCollectionsWithFields();

  // Entry counts in ONE grouped query rather than one per collection.
  const db = drizzle(env.DB);
  const counts = await db
    .select({ collectionId: entries.collectionId, total: count() })
    .from(entries)
    .groupBy(entries.collectionId)
    .all();
  const byCollection = new Map(counts.map((c) => [c.collectionId, c.total]));

  const promotionBudget = await registry.service.promotions.budget();

  return {
    collections: collections.map((c) => ({
      id: c.id,
      apiId: c.apiId,
      kind: c.kind,
      localized: c.localized,
      draftPublish: c.draftPublish,
      system: c.system,
      description: c.description,
      fieldCount: c.fields.length,
      promotedCount: c.fields.filter((f) => f.promoted).length,
      entryCount: byCollection.get(c.id) ?? 0,
    })),
    promotionBudget,
  };
};

export const actions: Actions = {
  createCollection: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const apiId = String(fd.get("apiId") ?? "").trim();
    const kind = String(fd.get("kind") ?? "collection");
    const description = String(fd.get("description") ?? "").trim() || undefined;

    if (kind !== "collection" && kind !== "single" && kind !== "component") {
      return fail(400, { error: "Invalid kind" });
    }

    try {
      const registry = createRegistryQuery(env);
      const created = await registry.service.createCollection({
        apiId,
        kind,
        localized: fd.get("localized") === "true",
        draftPublish: fd.get("draftPublish") === "true",
        description,
        createdBy: locals.user.id,
      });
      await logAudit(env.DB, locals.user.id, "collection.create", created.id, {
        apiId,
        kind,
      });
      return { success: true, message: `Created "${apiId}"` };
    } catch (err) {
      // RegistryError carries a specific reason (bad apiId, reserved
      // name, shadows a built-in) — surface it rather than a generic
      // failure, because the fix is always caller-side.
      return fail(400, {
        error:
          err instanceof RegistryError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to create collection",
      });
    }
  },

  deleteCollection: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const apiId = String(fd.get("apiId") ?? "").trim();
    // Deleting a collection cascades to every entry in it. Require the
    // apiId to be retyped so a stray click can't destroy content.
    const confirm = String(fd.get("confirm") ?? "").trim();
    if (!apiId) return fail(400, { error: "Missing apiId" });
    if (confirm !== apiId) {
      return fail(400, {
        error: `Type "${apiId}" to confirm — this deletes every entry in it`,
      });
    }

    try {
      const registry = createRegistryQuery(env);
      await registry.service.deleteCollection(apiId);
      await logAudit(env.DB, locals.user.id, "collection.delete", apiId, {
        apiId,
      });
      return { success: true, message: `Deleted "${apiId}"` };
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to delete",
      });
    }
  },
};
