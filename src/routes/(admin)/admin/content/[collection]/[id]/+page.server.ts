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
import { error, fail, redirect, type ActionFailure } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { createRegistryQuery } from "$lib/server/content/registry";
import {
  entries,
  entryLocalizations,
  entryRelations,
  entryVersions,
} from "$lib/server/content/registry/schema";
import { RegistryError } from "$lib/server/content/registry/types";
import { parseFieldName } from "$lib/components/admin/registry/field-map";
import {
  createAttributeService,
  AttributeError,
  FAMILIES,
  type RawValueInput,
} from "$lib/server/content/attributes";
import { buildRelationChoices } from "./relation-choices.server";
import type { Actions, PageServerLoad } from "./$types";

const NEW = "new";

/** Cap on entries offered in a relation picker before it needs search. */
const RELATION_CHOICE_LIMIT = 200;

export const load: PageServerLoad = async ({
  params,
  locals,
  platform,
  url,
}) => {
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

  const supportedLocales = (env.SUPPORTED_LOCALES ?? "en,th")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const defaultLocale = env.DEFAULT_LOCALE ?? supportedLocales[0] ?? "en";

  // Pick-lists for relation/component fields — see relation-choices.
  // The selected targets are ALWAYS unioned in, because the picker posts
  // the full desired id list on save: a selected target missing from
  // the choice window would be silently dropped from the entry (#126).
  const relationQuery = (url.searchParams.get("relationQuery") ?? "").trim();
  const { choices: relationChoices, totals: relationTotals } =
    await buildRelationChoices(db, {
      fields: collection.fields,
      targetCollections: await registry.service.listCollectionsWithFields(),
      selected: relations,
      defaultLocale,
      query: relationQuery,
      limit: RELATION_CHOICE_LIMIT,
    });

  // ── Spec/attribute values (#130) — sidecar to the entry document.
  const attrService = createAttributeService(env);
  const attributeDefs = await attrService.listAttributes();
  const specAttributes = attributeDefs.map((a) => ({
    key: a.key,
    dataType: a.dataType,
    measureFamily: a.measureFamily,
    standardUnit: a.standardUnit,
    options: safeParseArray(a.optionsJson),
    qualifiers: safeParseArray(a.qualifiersJson),
    groupKey: a.groupKey,
  }));
  const specValues =
    isNew || !entry
      ? []
      : await attrService.listEntityValues("entry", entry.id);
  // Unit pick-lists per family, shipped from the server because units.ts
  // lives under $lib/server and cannot be imported by the component.
  const unitsByFamily = Object.fromEntries(
    Object.entries(FAMILIES).map(([family, def]) => [
      family,
      Object.keys(def.units),
    ]),
  );

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
    relationTotals,
    relationQuery,
    specAttributes,
    specValues,
    unitsByFamily,
    supportedLocales,
    defaultLocale,
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

  /**
   * Upsert one spec value on this entry (#130). Separate action rather
   * than part of `save` because spec values are a sidecar keyed by
   * (attribute, locale, qualifier) — folding them into the entry form
   * would force the whole document through validation to change one
   * number.
   */
  setSpecValue: async ({ params, request, locals, platform }) => {
    const gate = specGate(params.id, locals, platform);
    if ("fail" in gate) return gate.fail;

    const fd = await request.formData();
    const attributeKey = String(fd.get("attributeKey") ?? "").trim();
    if (!attributeKey) {
      return fail(400, { specError: "Pick an attribute first" });
    }
    const qualifier = String(fd.get("qualifier") ?? "").trim() || undefined;

    try {
      const attr = await gate.service.getAttributeByKey(attributeKey);
      if (!attr) {
        return fail(400, { specError: `Unknown attribute "${attributeKey}"` });
      }
      const input = specInputFor(attr.dataType, fd);
      await gate.service.setValue(
        "entry",
        params.id,
        attributeKey,
        input,
        qualifier,
      );
      await logAudit(gate.env.DB, gate.userId, "entry.update", params.id, {
        collection: params.collection,
        spec: attributeKey,
      });
      return { specSuccess: "Value saved" };
    } catch (err) {
      return fail(400, {
        specError:
          err instanceof AttributeError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to save value",
      });
    }
  },

  removeSpecValue: async ({ params, request, locals, platform }) => {
    const gate = specGate(params.id, locals, platform);
    if ("fail" in gate) return gate.fail;

    const fd = await request.formData();
    const attributeKey = String(fd.get("attributeKey") ?? "").trim();
    if (!attributeKey) return fail(400, { specError: "Missing attribute" });
    const qualifier = String(fd.get("qualifier") ?? "").trim() || undefined;
    const locale = String(fd.get("locale") ?? "").trim() || undefined;

    try {
      await gate.service.removeValue(
        "entry",
        params.id,
        attributeKey,
        qualifier,
        locale,
      );
      await logAudit(gate.env.DB, gate.userId, "entry.update", params.id, {
        collection: params.collection,
        specRemoved: attributeKey,
      });
      return { specSuccess: "Value removed" };
    } catch (err) {
      return fail(400, {
        specError:
          err instanceof AttributeError
            ? err.message
            : "Failed to remove value",
      });
    }
  },
};

/**
 * Shared guard for the spec actions: auth, role, platform, and "the
 * entry must already exist" — a value row needs a stable entity id, and
 * `new` is not one.
 */
function specGate(
  id: string,
  locals: App.Locals,
  platform: App.Platform | undefined,
):
  | { fail: ActionFailure<{ specError: string }> }
  | {
      env: App.Platform["env"];
      service: ReturnType<typeof createAttributeService>;
      userId: string;
    } {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    return { fail: fail(403, { specError: "Forbidden" }) };
  }
  const env = platform?.env;
  if (!env) return { fail: fail(503, { specError: "Platform not ready" }) };
  if (id === NEW) {
    return {
      fail: fail(400, {
        specError: "Save the entry first, then add specifications",
      }),
    };
  }
  return { env, service: createAttributeService(env), userId: locals.user.id };
}

/**
 * Map the posted form row onto the discriminated RawValueInput for the
 * attribute's data type. Only the TYPE shape is enforced here — the
 * service does the real validation (finite numbers, known units,
 * declared options) and its AttributeError messages surface verbatim.
 */
function specInputFor(dataType: string, fd: FormData): RawValueInput {
  const num = (key: string): number | undefined => {
    const raw = String(fd.get(key) ?? "").trim();
    if (!raw) return undefined;
    return Number(raw);
  };

  switch (dataType) {
    case "number": {
      const value = num("value");
      if (value === undefined) {
        throw new AttributeError("A value is required", "INVALID_VALUE");
      }
      return { kind: "number", value, max: num("max") };
    }
    case "measurement": {
      const value = num("value");
      if (value === undefined) {
        throw new AttributeError("A value is required", "INVALID_VALUE");
      }
      return {
        kind: "measurement",
        value,
        unit: String(fd.get("unit") ?? "").trim(),
        max: num("max"),
      };
    }
    case "select":
      return { kind: "select", option: String(fd.get("option") ?? "") };
    case "multiselect":
      return {
        kind: "multiselect",
        options: fd
          .getAll("options")
          .map((o) => String(o))
          .filter(Boolean),
      };
    case "boolean":
      // Hidden "false" companion + checkbox "true": take the last value,
      // same convention as the entry form's checkboxes.
      return {
        kind: "boolean",
        value: String(fd.getAll("bool").at(-1) ?? "false") === "true",
      };
    case "text": {
      const locale = String(fd.get("locale") ?? "").trim() || undefined;
      return { kind: "text", value: String(fd.get("text") ?? ""), locale };
    }
    default:
      throw new AttributeError(
        `Unknown data type "${dataType}"`,
        "INVALID_DATA_TYPE",
      );
  }
}

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

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((o): o is string => typeof o === "string")
      : [];
  } catch {
    return [];
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
