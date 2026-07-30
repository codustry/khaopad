import { error, fail, redirect } from "@sveltejs/kit";
import { logAudit } from "$lib/server/audit";
import { canManageSecrets } from "$lib/server/auth/permissions";
import { secretsByGroup, isManagedSecret } from "$lib/server/secrets/registry";
import {
  listSecretStatus,
  setSecret,
  deleteSecret,
} from "$lib/server/secrets/service";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Credential management is **super_admin only** — deliberately stricter
 * than `canManageSettings` (which admits `admin`) used by the general
 * settings page.
 *
 * The values here create charges and issue refunds against a live payment
 * account. A site title is reversible; a leaked Beam key is not. Where the
 * two roles differ, credentials belong with the narrower one.
 */
function requireSuperAdmin(locals: App.Locals) {
  if (!locals.user) throw error(401, "Not authenticated");
  if (!canManageSecrets(locals.user)) {
    throw error(
      403,
      "Only super admins can manage integration credentials. These keys can move money.",
    );
  }
}

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  requireSuperAdmin(locals);

  const env = platform?.env;
  if (!env?.DB) {
    return {
      groups: [...secretsByGroup()].map(([name, defs]) => ({ name, defs })),
      statuses: [],
      platformReady: false,
      hasMasterSecret: false,
    };
  }

  // Status only — never the plaintext of a sensitive value. The form is
  // write-only by design: round-tripping a live key to the browser would
  // put it in page source, history, extensions and any proxy in the path.
  const statuses = await listSecretStatus(env);

  return {
    groups: [...secretsByGroup()].map(([name, defs]) => ({ name, defs })),
    statuses,
    platformReady: true,
    // Without BETTER_AUTH_SECRET there is no key-derivation root, so
    // nothing can be encrypted. Surfaced so the page explains itself
    // rather than failing on submit.
    hasMasterSecret: Boolean(env.BETTER_AUTH_SECRET),
  };
};

export const actions: Actions = {
  save: async ({ request, locals, platform }) => {
    requireSuperAdmin(locals);
    const env = platform?.env;
    if (!env?.DB) return fail(503, { error: "Database is not available." });

    const form = await request.formData();
    const key = String(form.get("key") ?? "");
    const value = String(form.get("value") ?? "");

    if (!isManagedSecret(key)) {
      return fail(400, { error: `Unknown secret: ${key}` });
    }
    // Empty submit is a no-op, not a delete. Deleting is its own explicit
    // action — otherwise a stray Enter on a blank field silently removes a
    // live payment credential.
    if (!value.trim()) {
      return fail(400, {
        error: "Value is empty. Use Remove to clear a stored secret.",
      });
    }

    try {
      await setSecret(env, key, value.trim(), locals.user!.id);
    } catch (err) {
      return fail(500, {
        error: err instanceof Error ? err.message : "Failed to store secret.",
      });
    }

    // Audit the CHANGE, never the value. An audit log that records
    // credentials is a second place to leak them.
    await logAudit(env.DB, locals.user!.id, "settings.secret.update", key, {
      key,
    });

    return { success: true, key };
  },

  remove: async ({ request, locals, platform }) => {
    requireSuperAdmin(locals);
    const env = platform?.env;
    if (!env?.DB) return fail(503, { error: "Database is not available." });

    const form = await request.formData();
    const key = String(form.get("key") ?? "");
    if (!isManagedSecret(key)) {
      return fail(400, { error: `Unknown secret: ${key}` });
    }

    await deleteSecret(env, key);
    await logAudit(env.DB, locals.user!.id, "settings.secret.delete", key, {
      key,
    });

    return { success: true, key, removed: true };
  },
};
