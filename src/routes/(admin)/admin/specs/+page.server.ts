/**
 * /admin/specs — attribute + family definitions — Phase 3 (#88, #130).
 *
 * The WRITE side of the spec layer: define typed attributes (with unit
 * families and option vocabularies) and assemble them into families.
 * The read side already ships at /api/public/specs/*.
 *
 * Editors may BROWSE (same rationale as /admin/content, #125): the specs
 * an entry carries are editor-facing, so the definitions must at least
 * be visible to editors. DEFINING an attribute or family is a schema
 * change and stays with admins; the page hides the forms for editors via
 * `canManage`, and every action below keeps its own admin guard.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import {
  AttributeError,
  createAttributeService,
  FAMILIES,
  MEASURE_FAMILIES,
} from "$lib/server/content/attributes";
import type { Actions, PageServerLoad } from "./$types";

function surfaced(err: unknown, fallback: string): string {
  // AttributeError carries a specific caller-fixable reason (bad key,
  // duplicate, unknown unit family, still-in-use) — surface it verbatim.
  if (err instanceof AttributeError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function optionCountOf(optionsJson: string | null): number {
  if (!optionsJson) return 0;
  try {
    const parsed = JSON.parse(optionsJson);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw error(403, "Editors and above can browse spec definitions.");
  }
  const canManage = hasRole(locals.user, "admin");
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const specs = createAttributeService(env);
  const [attrs, familyRows] = await Promise.all([
    specs.listAttributes(),
    specs.listFamilies(),
  ]);

  // Ordered attribute list per family. One query per family is fine at
  // admin-page scale (families are product types — single digits).
  const families = await Promise.all(
    familyRows.map(async (f) => ({
      key: f.key,
      description: f.description,
      attributes: (await specs.familyAttributeList(f.key)).map((r) => ({
        key: r.attribute.key,
        dataType: r.attribute.dataType,
        required: r.required,
        sortOrder: r.sortOrder,
        isVariantAxis: r.isVariantAxis,
      })),
    })),
  );

  // Reverse index: which families declare each attribute — shown in the
  // definitions table, and the reason a delete may be refused.
  const membership = new Map<string, string[]>();
  for (const f of families) {
    for (const a of f.attributes) {
      const list = membership.get(a.key) ?? [];
      list.push(f.key);
      membership.set(a.key, list);
    }
  }

  return {
    canManage,
    attributes: attrs.map((a) => ({
      key: a.key,
      dataType: a.dataType,
      measureFamily: a.measureFamily,
      standardUnit: a.standardUnit,
      optionCount: optionCountOf(a.optionsJson),
      groupKey: a.groupKey,
      families: membership.get(a.key) ?? [],
    })),
    families,
    attributeKeys: attrs.map((a) => a.key),
    measureFamilies: MEASURE_FAMILIES.map((key) => ({
      key,
      standardUnit: FAMILIES[key].standardUnit,
    })),
  };
};

export const actions: Actions = {
  createAttribute: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const key = String(fd.get("key") ?? "").trim();
    const dataType = String(fd.get("dataType") ?? "").trim();
    const measureFamily = String(fd.get("measureFamily") ?? "").trim();
    // Comma- or newline-separated option keys for select/multiselect.
    const options = String(fd.get("options") ?? "")
      .split(/[\n,]/)
      .map((o) => o.trim())
      .filter(Boolean);
    const groupKey = String(fd.get("groupKey") ?? "").trim();
    const labelEn = String(fd.get("labelEn") ?? "").trim();
    const labelTh = String(fd.get("labelTh") ?? "").trim();

    const labels: Record<string, { label: string }> = {};
    if (labelEn) labels.en = { label: labelEn };
    if (labelTh) labels.th = { label: labelTh };

    try {
      const specs = createAttributeService(env);
      const created = await specs.createAttribute({
        key,
        // The service validates against ATTRIBUTE_DATA_TYPES; a bad value
        // comes back as INVALID_DATA_TYPE rather than corrupting anything.
        dataType: dataType as never,
        measureFamily: measureFamily || undefined,
        options: options.length ? options : undefined,
        groupKey: groupKey || undefined,
        labels: Object.keys(labels).length ? labels : undefined,
        createdBy: locals.user.id,
      });
      await logAudit(env.DB, locals.user.id, "attribute.create", created.id, {
        key,
        dataType,
      });
      return { success: true, message: `Created attribute "${key}"` };
    } catch (err) {
      return fail(400, { error: surfaced(err, "Failed to create attribute") });
    }
  },

  deleteAttribute: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const key = String(fd.get("key") ?? "").trim();
    // Retype-to-confirm, same pattern as deleting a content type: the
    // service already refuses while any family declares the attribute,
    // but an unused definition still shouldn't die to a stray click.
    const confirm = String(fd.get("confirm") ?? "").trim();
    if (!key) return fail(400, { error: "Missing attribute key" });
    if (confirm !== key) {
      return fail(400, { error: `Type "${key}" to confirm deletion` });
    }

    try {
      const specs = createAttributeService(env);
      await specs.deleteAttribute(key);
      await logAudit(env.DB, locals.user.id, "attribute.delete", key, { key });
      return { success: true, message: `Deleted attribute "${key}"` };
    } catch (err) {
      return fail(400, { error: surfaced(err, "Failed to delete attribute") });
    }
  },

  createFamily: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const key = String(fd.get("key") ?? "").trim();
    const description = String(fd.get("description") ?? "").trim();
    const labelEn = String(fd.get("labelEn") ?? "").trim();
    const labelTh = String(fd.get("labelTh") ?? "").trim();

    const labels: Record<string, string> = {};
    if (labelEn) labels.en = labelEn;
    if (labelTh) labels.th = labelTh;

    try {
      const specs = createAttributeService(env);
      const created = await specs.createFamily({
        key,
        description: description || undefined,
        labels: Object.keys(labels).length ? labels : undefined,
        createdBy: locals.user.id,
      });
      await logAudit(
        env.DB,
        locals.user.id,
        "attribute_family.create",
        created.id,
        {
          key,
        },
      );
      return { success: true, message: `Created family "${key}"` };
    } catch (err) {
      return fail(400, { error: surfaced(err, "Failed to create family") });
    }
  },

  addToFamily: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const familyKey = String(fd.get("familyKey") ?? "").trim();
    const attributeKey = String(fd.get("attributeKey") ?? "").trim();
    const sortOrderRaw = String(fd.get("sortOrder") ?? "").trim();
    const sortOrder = sortOrderRaw ? Number(sortOrderRaw) : 0;
    if (!familyKey || !attributeKey) {
      return fail(400, { error: "Family and attribute are both required" });
    }
    if (!Number.isFinite(sortOrder)) {
      return fail(400, { error: "Sort order must be a number" });
    }

    try {
      const specs = createAttributeService(env);
      await specs.addAttributeToFamily(familyKey, attributeKey, {
        required: fd.get("required") === "true",
        isVariantAxis: fd.get("isVariantAxis") === "true",
        sortOrder,
      });
      await logAudit(
        env.DB,
        locals.user.id,
        "attribute_family.add",
        familyKey,
        {
          familyKey,
          attributeKey,
          sortOrder,
        },
      );
      return {
        success: true,
        message: `Added "${attributeKey}" to "${familyKey}"`,
      };
    } catch (err) {
      return fail(400, { error: surfaced(err, "Failed to add to family") });
    }
  },
};
