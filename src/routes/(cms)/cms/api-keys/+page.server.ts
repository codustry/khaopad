import { error, fail, redirect } from "@sveltejs/kit";
import { canManageUsers } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import type { ApiKeyScope } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

const KNOWN_SCOPES: ApiKeyScope[] = [
  "*:read",
  "articles:read",
  "categories:read",
  "tags:read",
  "pages:read",
];

/**
 * `/cms/api-keys` — admin+ only. The raw key is shown ONCE on
 * create; we return it via `form.rawKey` and the page surfaces a
 * one-time secret card. Subsequent visits show only the `prefix`
 * (first 12 chars) so the operator can match a key against a
 * password manager entry.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageUsers(locals.user)) {
    throw error(403, "Only admins can manage API keys.");
  }
  const keys = await locals.content.listApiKeys();
  return { keys, knownScopes: KNOWN_SCOPES };
};

export const actions: Actions = {
  create: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) return fail(403, { error: "Forbidden" });
    const fd = await request.formData();
    const label = String(fd.get("label") ?? "").trim();
    const scopes = fd
      .getAll("scopes")
      .map((v) => String(v))
      .filter((v): v is ApiKeyScope =>
        (KNOWN_SCOPES as string[]).includes(v),
      );
    const expiresAtRaw = String(fd.get("expires_at") ?? "").trim();
    const expiresAt = expiresAtRaw
      ? new Date(expiresAtRaw).toISOString()
      : null;

    if (!label) return fail(400, { error: "Label is required." });
    if (scopes.length === 0) {
      return fail(400, { error: "Pick at least one scope." });
    }

    const result = await locals.content.createApiKey({
      label,
      scopes,
      expiresAt,
      createdBy: locals.user.id,
    });
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        result.record.id,
        { kind: "api_key.create", label, scopes },
      );
    }
    // Return the raw key in form data — the page shows it once and
    // the operator copies it. After this response it's never
    // recoverable (we only store the SHA-256 hash).
    return {
      ok: true,
      created: {
        id: result.record.id,
        label: result.record.label,
        rawKey: result.rawKey,
      },
    };
  },

  revoke: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) return fail(403, { error: "Forbidden" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });
    await locals.content.revokeApiKey(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "api_key.revoke" },
      );
    }
    return { ok: true };
  },

  delete: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageUsers(locals.user)) return fail(403, { error: "Forbidden" });
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing id" });
    await locals.content.deleteApiKey(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "settings.update",
        id,
        { kind: "api_key.delete" },
      );
    }
    return { ok: true };
  },
};
