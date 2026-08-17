import { error, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/content/schema";
import { createAuth } from "$lib/server/auth";
import { logAudit } from "$lib/server/audit";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Self-service profile (#--).
 *
 * Before this page existed there was NO way for anyone — super_admin
 * included — to change a password through the UI. `/admin/users` only
 * offers role changes, deletion and invitations, and it is gated to
 * admin+ so editors and authors could not reach even that. The only
 * recovery path was delete-and-reinvite, which the `authorId` foreign
 * key blocks outright once a user has written an article.
 *
 * Better Auth's `changePassword` endpoint was already mounted (the
 * `/api/auth/[...all]` catch-all plus `emailAndPassword: { enabled: true }`),
 * so the server capability existed the whole time — only the door was
 * missing. We call it through `auth.api` from a form action rather than
 * fetching the endpoint from the browser, so SvelteKit's built-in
 * origin check applies to the POST. (The login page uses a raw fetch
 * only because it runs before a session exists.)
 */

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!platform?.env?.DB) throw error(503, "Platform not configured");

  return {
    profile: {
      id: locals.user.id,
      name: locals.user.name,
      email: locals.user.email,
      role: locals.user.role,
      image: locals.user.image ?? null,
    },
  };
};

export const actions: Actions = {
  /**
   * Change your own password.
   *
   * Better Auth verifies `currentPassword` against the stored hash
   * internally — there is deliberately no bypass here, and no branch
   * that skips the check for privileged roles.
   *
   * `revokeOtherSessions: true` is the point of the whole action: a
   * password change is what you do when you believe someone else has
   * your credentials, so leaving their sessions alive would make the
   * change cosmetic.
   */
  changePassword: async ({ request, locals, platform }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!platform?.env?.DB) throw error(503, "Platform not configured");

    const form = await request.formData();
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");

    if (!currentPassword || !newPassword) {
      return {
        ok: false,
        error: "Current password and new password are both required.",
      };
    }
    if (newPassword.length < 8) {
      return {
        ok: false,
        error: "The new password must be at least 8 characters.",
      };
    }
    // Re-checked server-side even though the page checks it too: the
    // client check is a convenience, not a control.
    if (newPassword !== confirmPassword) {
      return { ok: false, error: "The new passwords do not match." };
    }
    if (newPassword === currentPassword) {
      return {
        ok: false,
        error: "The new password must differ from the current one.",
      };
    }

    const auth = createAuth(platform.env.DB, {
      BETTER_AUTH_SECRET: platform.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: platform.env.BETTER_AUTH_URL,
    });

    try {
      await auth.api.changePassword({
        body: {
          currentPassword,
          newPassword,
          // Sign every OTHER device out. This session keeps its cookie.
          revokeOtherSessions: true,
        },
        headers: request.headers,
      });
    } catch (err) {
      // Better Auth returns a generic failure for a wrong current
      // password; surface it without leaking which half was wrong.
      const msg = err instanceof Error ? err.message : "Password change failed";
      return { ok: false, error: msg };
    }

    // Metadata carries NO password material — not the old one, not the
    // new one, not a length, not a prefix. The audit row records that a
    // change happened and who did it; that is all it is allowed to know.
    await logAudit(
      platform.env.DB,
      locals.user.id,
      "user.password_change",
      locals.user.id,
      { revokedOtherSessions: true },
    );

    return { ok: true, changed: "password" as const };
  },

  /**
   * Update your own display name and avatar.
   *
   * Email is DELIBERATELY not updatable here. Under Better Auth,
   * changing the address of an existing account goes through
   * `changeEmail`, which sends a verification message to the current
   * address before the new one takes effect. This deployment treats
   * transactional email as optional — `RESEND_API_KEY` is documented as
   * "Leave unset to disable transactional email" — so wiring email
   * changes in would either hard-require Resend or, worse, let an
   * address change through unverified. Neither belongs in a fix whose
   * job is to unblock password changes. Changing an email stays an
   * admin-assisted operation.
   */
  updateProfile: async ({ request, locals, platform }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    if (!platform?.env?.DB) throw error(503, "Platform not configured");

    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const image = String(form.get("image") ?? "").trim();

    if (!name) return { ok: false, error: "Name is required." };
    if (name.length > 120) {
      return { ok: false, error: "Name must be 120 characters or fewer." };
    }

    const db = drizzle(platform.env.DB, { schema });
    await db
      .update(schema.users)
      .set({
        name,
        image: image || null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.users.id, locals.user.id));

    return { ok: true, changed: "profile" as const };
  },
};
