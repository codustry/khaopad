/**
 * /admin/content/[collection]/[id] — registry-driven entry editor.
 *
 * Phase 4 (#68 §F). The form is generated from `collection_fields`, so a
 * content type created by inserting registry rows is immediately
 * editable — no per-type form component. This is what replaces
 * `ArticleForm.svelte` / `PageForm.svelte` for user-defined types.
 *
 * `id === "new"` renders an empty form; anything else loads that entry.
 * One route rather than two because the field rendering, validation and
 * save path are identical — only the initial values differ.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq, inArray } from "drizzle-orm";
import { createRegistryQuery } from "$lib/server/content/registry";
import {
  entries,
  entryLocalizations,
  entryRelations,
  entryVersions,
} from "$lib/server/content/registry/schema";
import { RegistryError } from "$lib/server/content/registry/types";
import { RELATIONAL_FIELD_TYPES } from "$lib/server/content/registry/types";
import { parseFieldName } from "$lib/components/admin/registry/field-map";
import type { Actions, PageServerLoad } from "./$types";

const NEW = "new";

/** Cap on entries offered in a relation picker before it needs search. */
const RELATION_CHOICE_LIMIT = 200;

export const load: PageServerLoad = async ({ params, locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) throw redirect(302, "/admin");
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const registry = createRegistryQuery(env);
  const collection = await registry.service.getCollection(params.collection);
  if (!collection) {
    throw error(404, `Unknown content type "${params.collection}"`);
  }

  const isNew = params.id === NEW;
  const db = drizzle(env.DB);

  let entry: typeof entries.$inferSelect | null = null;
  let document: Record<string, unknown> = {};
  const localized: Record<string, Record<string, unknown>> = {};
  const relations: Record<string, string[]> = {};

  if (!isNew) {
    entry =
      (await db
        .select()
        .from(entries)
        .where(eq(entries.id, params.id))
        .limit(1)
        .get()) ?? null;
    if (!entry) throw error(404, "Entry not found");
    // An entry id is globally unique, so a mismatched collection in the
    // URL means a stale or hand-edited link — 404 rather than silently
    // editing it under the wrong schema.
    if (entry.collectionId !== collection.id) {
      throw error(404, `Entry does not belong to "${collection.apiId}"`);
    }

    document = safeParse(entry.dataJson);

    const locRows = await db
      .select()
      .from(entryLocalizations)
      .where(eq(entryLocalizations.entryId, entry.id))
      .all();
    for (const row of locRows) {
      localized[row.locale] = safeParse(row.dataJson);
    }

    const relRows = await db
      .select()
      .from(entryRelations)
      .where(eq(entryRelations.entryId, entry.id))
      .orderBy(asc(entryRelations.position))
      .all();
    for (const row of relRows) {
      const list = relations[row.fieldApiId] ?? [];
      // #99: an edge targets either an entry we own or an external
      // reference. External targets are round-tripped as
      // `namespace:ref` — a single string keeps the existing form
      // encoding (one comma-separated field per relation) working for
      // both shapes, and the save action splits it back apart.
      if (row.targetKind === "external") {
        if (row.targetNamespace && row.targetRef) {
          list.push(`${row.targetNamespace}:${row.targetRef}`);
        }
      } else if (row.targetEntryId) {
        list.push(row.targetEntryId);
      }
      relations[row.fieldApiId] = list;
    }
  }

  // Pick-lists for relation/component fields. Loaded in ONE query for
  // every target collection this type points at, rather than per field.
  const targetApiIds = new Set<string>();
  for (const field of collection.fields) {
    if (!RELATIONAL_FIELD_TYPES.has(field.type)) continue;
    const cfg = safeParse(field.configJson ?? "{}");
    if (typeof cfg.target === "string") targetApiIds.add(cfg.target);
    if (Array.isArray(cfg.allowed)) {
      for (const a of cfg.allowed) {
        if (typeof a === "string") targetApiIds.add(a);
      }
    }
  }

  const relationChoices: Record<string, { id: string; label: string }[]> = {};
  if (targetApiIds.size > 0) {
    const all = await registry.service.listCollections();
    const wanted = all.filter((c) => targetApiIds.has(c.apiId));
    if (wanted.length > 0) {
      const rows = await db
        .select({
          id: entries.id,
          slug: entries.slug,
          collectionId: entries.collectionId,
        })
        .from(entries)
        .where(
          inArray(
            entries.collectionId,
            wanted.map((c) => c.id),
          ),
        )
        .limit(RELATION_CHOICE_LIMIT)
        .all();
      const apiIdById = new Map(wanted.map((c) => [c.id, c.apiId]));
      for (const field of collection.fields) {
        if (!RELATIONAL_FIELD_TYPES.has(field.type)) continue;
        const cfg = safeParse(field.configJson ?? "{}");
        const allowed = new Set<string>(
          typeof cfg.target === "string"
            ? [cfg.target]
            : Array.isArray(cfg.allowed)
              ? (cfg.allowed as string[])
              : [],
        );
        relationChoices[field.apiId] = rows
          .filter((r) => allowed.has(apiIdById.get(r.collectionId) ?? ""))
          .map((r) => ({ id: r.id, label: r.slug ?? r.id }));
      }
    }
  }

  const supportedLocales = (env.SUPPORTED_LOCALES ?? "en,th")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  // Version count only — snapshots can be large and the editor doesn't
  // render them, so loading the JSON would be wasted bytes.
  const versionCount = entry
    ? (
        await db
          .select({ id: entryVersions.id })
          .from(entryVersions)
          .where(eq(entryVersions.entryId, entry.id))
          .all()
      ).length
    : 0;

  return {
    isNew,
    collection: {
      apiId: collection.apiId,
      kind: collection.kind,
      localized: collection.localized,
      draftPublish: collection.draftPublish,
      fields: collection.fields,
    },
    entry: entry
      ? {
          id: entry.id,
          slug: entry.slug,
          status: entry.status,
          publishedAt: entry.publishedAt,
          updatedAt: entry.updatedAt,
        }
      : null,
    values: { document, localized, relations },
    relationChoices,
    supportedLocales,
    defaultLocale: env.DEFAULT_LOCALE ?? supportedLocales[0] ?? "en",
    versionCount,
  };
};

export const actions: Actions = {
  save: async ({ params, request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const registry = createRegistryQuery(env);
    const collection = await registry.service.getCollection(params.collection);
    if (!collection) return fail(404, { error: "Unknown content type" });

    const fieldsByApiId = new Map(collection.fields.map((f) => [f.apiId, f]));

    // Reassemble the namespaced form keys (f./l.<locale>./r.) into the
    // shape upsertEntry expects. Unknown keys are ignored rather than
    // rejected — the form also carries slug/status/action fields.
    const document: Record<string, unknown> = {};
    const localizations: Record<string, Record<string, unknown>> = {};
    const relations: Record<string, string[]> = {};

    for (const [key, raw] of fd.entries()) {
      const parsed = parseFieldName(key);
      if (!parsed) continue;
      const field = fieldsByApiId.get(parsed.apiId);
      if (!field) continue;

      if (parsed.kind === "relation") {
        // A <select multiple> posts one entry per selection; a hidden
        // input posts a comma-joined string. Handle both.
        const all = fd.getAll(key).flatMap((v) =>
          String(v)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        relations[parsed.apiId] = Array.from(new Set(all));
        continue;
      }

      // A checkbox posts its hidden "false" companion AND "true" when
      // checked, so take the LAST value — the checkbox is rendered after
      // the hidden input.
      const values = fd.getAll(key);
      const value = String(values[values.length - 1] ?? raw);

      if (parsed.kind === "doc") {
        document[parsed.apiId] = coerceForField(field.type, value);
      } else {
        const bucket = localizations[parsed.locale] ?? {};
        bucket[parsed.apiId] = coerceForField(field.type, value);
        localizations[parsed.locale] = bucket;
      }
    }

    const slugRaw = String(fd.get("slug") ?? "").trim();
    const statusRaw = String(fd.get("status") ?? "");
    const status =
      statusRaw === "published" ||
      statusRaw === "archived" ||
      statusRaw === "draft"
        ? statusRaw
        : undefined;

    try {
      const saved = await registry.service.upsertEntry(params.collection, {
        id: params.id === NEW ? undefined : params.id,
        slug: slugRaw || undefined,
        status,
        data: document,
        localizations,
        relations,
        createdBy: locals.user.id,
      });
      await logAudit(
        env.DB,
        locals.user.id,
        params.id === NEW ? "entry.create" : "entry.update",
        saved.id,
        { collection: params.collection },
      );

      // Redirect after create so the URL stops saying "new" — otherwise a
      // refresh would create a second entry.
      if (params.id === NEW) {
        throw redirect(
          303,
          `/admin/content/${params.collection}/${saved.id}?created=1`,
        );
      }
      return { success: true, message: "Saved" };
    } catch (err) {
      // A thrown redirect is control flow, not an error — rethrow it or
      // the create path silently reports failure after succeeding.
      if (isRedirect(err)) throw err;
      return fail(400, {
        error:
          err instanceof RegistryError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to save",
      });
    }
  },
};

/** SvelteKit signals redirects by throwing; distinguish from real errors. */
function isRedirect(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    "location" in err
  );
}

/**
 * Form values are always strings. Convert to the shape the registry
 * validator expects; it does the real checking, so this only needs to
 * get the TYPE right.
 */
function coerceForField(type: string, value: string): unknown {
  if (value === "") return undefined;
  switch (type) {
    case "number":
      return Number(value);
    case "boolean":
      return value === "true";
    case "json":
      try {
        return JSON.parse(value);
      } catch {
        // Hand back the raw string so the validator reports "not
        // JSON-serializable" against the user's actual input rather than
        // this function swallowing it.
        return value;
      }
    default:
      return value;
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
