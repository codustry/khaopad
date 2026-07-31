/**
 * /admin/content/[collection] — field schema + entry list — Phase 4.
 *
 * Two jobs on one screen: define the type's fields, and list its
 * entries. Kept together because they're the same mental task early on
 * ("what is a Product, and what Products exist?").
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import { createRegistryQuery } from "$lib/server/content/registry";
import {
  entries,
  FIELD_TYPES,
  type FieldType,
} from "$lib/server/content/registry/schema";
import { RegistryError } from "$lib/server/content/registry/types";
import type { Actions, PageServerLoad } from "./$types";

/** Entries shown before paging; the list is a management aid, not a feed. */
const ENTRY_PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ params, locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw error(
      403,
      "Only editors, admins and super admins can access this area.",
    );
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const registry = createRegistryQuery(env);
  const collection = await registry.service.getCollection(params.collection);
  if (!collection)
    throw error(404, `Unknown content type "${params.collection}"`);

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: entries.id,
      slug: entries.slug,
      status: entries.status,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(eq(entries.collectionId, collection.id))
    .orderBy(desc(entries.updatedAt))
    .limit(ENTRY_PAGE_SIZE)
    .all();

  // Only admins may change the schema; editors manage entries. Surfaced
  // to the UI so it can hide the field form rather than letting an
  // editor submit something the action will reject.
  const canEditSchema = hasRole(locals.user, "admin");

  return {
    collection: {
      apiId: collection.apiId,
      kind: collection.kind,
      localized: collection.localized,
      system: collection.system,
      fields: collection.fields.map((f) => ({
        id: f.id,
        apiId: f.apiId,
        type: f.type,
        required: f.required,
        localized: f.localized,
        unique: f.unique,
        promoted: f.promoted,
        position: f.position,
        configJson: f.configJson,
      })),
    },
    entries: rows,
    entryPageSize: ENTRY_PAGE_SIZE,
    fieldTypes: FIELD_TYPES,
    canEditSchema,
    /** Targets a relation/component field can point at. */
    collectionChoices: (await registry.service.listCollections()).map((c) => ({
      apiId: c.apiId,
      kind: c.kind,
    })),
  };
};

export const actions: Actions = {
  addField: async ({ params, request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const apiId = String(fd.get("apiId") ?? "").trim();
    const type = String(fd.get("type") ?? "") as FieldType;
    if (!FIELD_TYPES.includes(type)) {
      return fail(400, { error: `Unknown field type "${type}"` });
    }

    // Per-type config is assembled here rather than accepting raw JSON
    // from the form — a hand-written configJson is the easiest way to
    // create a field the reader can't interpret.
    let config: Record<string, unknown> = {};
    if (type === "enum") {
      const options = String(fd.get("options") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      config = { options };
    } else if (type === "relation") {
      config = {
        target: String(fd.get("target") ?? "").trim(),
        cardinality: fd.get("cardinality") === "many" ? "many" : "one",
      };
    } else if (type === "component") {
      config = {
        allowed: String(fd.get("allowed") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        cardinality: fd.get("cardinality") === "one" ? "one" : "many",
      };
    } else if (type === "media") {
      config = {
        cardinality: fd.get("cardinality") === "many" ? "many" : "one",
      };
    }

    try {
      const registry = createRegistryQuery(env);
      const field = await registry.service.addField(params.collection, {
        apiId,
        type,
        required: fd.get("required") === "true",
        localized: fd.get("localized") === "true",
        unique: fd.get("unique") === "true",
        promoted: fd.get("promoted") === "true",
        config,
        position: Number(fd.get("position") ?? 0) || 0,
      });
      await logAudit(env.DB, locals.user.id, "collection.update", field.id, {
        collection: params.collection,
        addedField: apiId,
        type,
      });
      return { success: true, message: `Added field "${apiId}"` };
    } catch (err) {
      return fail(400, {
        error:
          err instanceof RegistryError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to add field",
      });
    }
  },

  removeField: async ({ params, request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const apiId = String(fd.get("apiId") ?? "").trim();
    if (!apiId) return fail(400, { error: "Missing field apiId" });

    try {
      const registry = createRegistryQuery(env);
      await registry.service.removeField(params.collection, apiId);
      await logAudit(env.DB, locals.user.id, "collection.update", apiId, {
        collection: params.collection,
        removedField: apiId,
      });
      // Values stay in each entry's document (see removeField) — say so,
      // because "deleted" would imply the content is gone.
      return {
        success: true,
        message: `Removed "${apiId}" from the schema. Stored values are kept and reappear if you re-add it.`,
      };
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to remove field",
      });
    }
  },

  deleteEntry: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing entry id" });

    try {
      const registry = createRegistryQuery(env);
      await registry.service.deleteEntry(id);
      await logAudit(env.DB, locals.user.id, "entry.delete", id, {});
      return { success: true, message: "Entry deleted" };
    } catch (err) {
      return fail(400, {
        error: err instanceof Error ? err.message : "Failed to delete entry",
      });
    }
  },
};
