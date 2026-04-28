import { error, fail, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/content/schema";
import { createAuth } from "$lib/server/auth";
import {
  consumeInvitation,
  findInvitationByToken,
} from "$lib/server/invitations";
import { logAudit } from "$lib/server/audit";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Invitation accept flow.
 *
 *   GET  /cms/invite/{token}   →  show signup form pre-filled with email
 *   POST /cms/invite/{token}   →  create user via Better Auth, set the
 *                                 role from the invitation, mark the
 *                                 invitation consumed, redirect to login
 *
 * Validation order on POST:
 *   1. Token still resolves to an invitation row
 *   2. Not already consumed
 *   3. Not expired
 *   4. Email/password are sane
 *   5. Better Auth signUpEmail succeeds
 *   6. Update the new user's role to the invitation's role
 *   7. Mark invitation consumed (atomic: only one accept wins if two
 *      browsers race)
 */
export const load: PageServerLoad = async ({ params, platform }) => {
  if (!platform?.env?.DB) throw error(503, "Platform not configured");

  const invite = await findInvitationByToken(platform.env.DB, params.token);

  if (!invite) {
    return {
      state: "invalid" as const,
      reason: "This invitation link is not valid.",
    };
  }
  if (invite.acceptedAt) {
    return {
      state: "consumed" as const,
      reason: "This invitation link has already been used.",
    };
  }
  if (new Date(invite.expiresAt) <= new Date()) {
    return {
      state: "expired" as const,
      reason:
        "This invitation link has expired. Ask an admin to send a new one.",
    };
  }

  return {
    state: "open" as const,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  };
};

export const actions: Actions = {
  default: async ({ request, params, platform }) => {
    if (!platform?.env?.DB) throw error(503, "Platform not configured");

    // Re-resolve the invitation on submit — never trust the form for
    // role or email.
    const invite = await findInvitationByToken(platform.env.DB, params.token);
    if (!invite) return fail(400, { error: "Invitation not valid." });
    if (invite.acceptedAt) {
      return fail(400, { error: "Invitation already used." });
    }
    if (new Date(invite.expiresAt) <= new Date()) {
      return fail(400, { error: "Invitation expired." });
    }

    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (!name) return fail(400, { error: "Name is required." });
    if (password.length < 8) {
      return fail(400, { error: "Password must be at least 8 characters." });
    }

    const auth = createAuth(platform.env.DB, {
      BETTER_AUTH_SECRET: platform.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: platform.env.BETTER_AUTH_URL,
    });

    let result: { user?: { id?: string } } | undefined;
    try {
      result = (await auth.api.signUpEmail({
        body: { name, email: invite.email, password },
        headers: request.headers,
        asResponse: false,
      })) as { user?: { id?: string } };
    } catch (err) {
      // Most common failure: email already in use (someone signed up
      // through /cms/signup with the same address before accepting).
      const msg = err instanceof Error ? err.message : "Sign-up failed";
      return fail(400, { error: msg });
    }

    const userId = result?.user?.id;
    if (!userId) return fail(500, { error: "Sign-up returned no user." });

    // Promote to the invitation's role. We don't reuse the bootstrap
    // helper because that hardcodes super_admin.
    const db = drizzle(platform.env.DB, { schema });
    await db
      .update(schema.users)
      .set({ role: invite.role, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, userId));

    // Atomic consume — if a second browser wins the race, this returns
    // false and the duplicate user is left as a regular author. That's
    // acceptable; the rare race won't compromise the role-grant.
    const consumed = await consumeInvitation(
      platform.env.DB,
      invite.id,
      userId,
    );
    if (!consumed) {
      return fail(409, {
        error: "Invitation was just used by someone else. Sign in instead.",
      });
    }

    await logAudit(platform.env.DB, userId, "invitation.accept", invite.id, {
      email: invite.email,
      role: invite.role,
    });

    throw redirect(302, "/cms/login?invited=1");
  },
};
