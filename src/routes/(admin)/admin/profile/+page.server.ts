import { error, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "$lib/server/content/schema";
import { createAuth } from "$lib/server/auth";
import { hasRole } from "$lib/server/auth/permissions";
import { guardedAuthHandler } from "$lib/server/auth/rate-limit-guard";
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
  changePassword: async ({ request, locals, platform, cookies }) => {
    if (!locals.user) throw error(401, "Not authenticated");
    // The admin layout's 403-below-author guard runs in its `load` — and
    // SvelteKit runs NO load functions for form actions, so a customer
    // session could POST here directly if this check lived only in the
    // layout. Every admin action must carry its own guard.
    if (!hasRole(locals.user, "author")) throw error(403, "Forbidden");
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
      CONTENT_CACHE: platform.env.CONTENT_CACHE,
    });

    // Routed through auth.handler — NOT auth.api.changePassword — on
    // purpose. Better Auth's rate limiter lives in its router's onRequest
    // hook, so a direct server-side api call skips it entirely, and this
    // form action would be an unthrottled current-password oracle: an
    // attacker holding a session cookie could brute-force the current
    // password at request speed while the "rate-limited" /api/auth
    // endpoint sat idle beside it. Going through the handler puts this
    // call under the same limiter as every other credential attempt.
    // Forward the ORIGINAL request's headers wholesale (then fix the
    // content type): Better Auth's CSRF check requires the Origin header,
    // and its rate limiter keys on the client IP headers. Hand-picking
    // `cookie` alone fails every request with "Missing or null Origin" —
    // including legitimate ones. Found live, not in tests: source
    // assertions cannot see what a constructed Request omits.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.set("content-type", "application/json");
    fwdHeaders.delete("content-length"); // body changed; let fetch recompute
    const authRes = await guardedAuthHandler(
      auth,
      new Request(new URL("/api/auth/change-password", request.url), {
        method: "POST",
        headers: fwdHeaders,
        body: JSON.stringify({
          currentPassword,
          newPassword,
          // Sign every OTHER device out. This session keeps its cookie.
          revokeOtherSessions: true,
        }),
      }),
      platform.env.AUTH_RATE_LIMITER,
    );
    if (authRes.status === 429) {
      return {
        ok: false,
        error: "Too many attempts. Wait a moment and try again.",
      };
    }
    // Better Auth ROTATES the session token on a password change and sends
    // the fresh cookie on its response. Dropping it signs the user out of
    // the very session they used to make the change — found live when the
    // follow-up request after a successful change came back 401. Forward
    // every Set-Cookie from the internal response onto ours.
    for (const raw of authRes.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const opts: Parameters<typeof cookies.set>[2] = { path: "/" };
      for (const a of attrs) {
        const [k, v] = a.split("=").map((x) => x.trim());
        const key = k.toLowerCase();
        if (key === "path" && v) opts.path = v;
        else if (key === "max-age") opts.maxAge = Number(v);
        else if (key === "expires" && v) opts.expires = new Date(v);
        else if (key === "httponly") opts.httpOnly = true;
        else if (key === "secure") opts.secure = true;
        else if (key === "samesite" && v)
          opts.sameSite = v.toLowerCase() as "lax" | "strict" | "none";
      }
      cookies.set(name, value, opts);
    }

    if (!authRes.ok) {
      // Better Auth returns a generic failure for a wrong current
      // password; surface it without leaking which half was wrong.
      let msg = "Password change failed";
      try {
        const body = (await authRes.json()) as { message?: string };
        if (body?.message) msg = body.message;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
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
    // The admin layout's 403-below-author guard runs in its `load` — and
    // SvelteKit runs NO load functions for form actions, so a customer
    // session could POST here directly if this check lived only in the
    // layout. Every admin action must carry its own guard.
    if (!hasRole(locals.user, "author")) throw error(403, "Forbidden");
    if (!platform?.env?.DB) throw error(503, "Platform not configured");

    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const image = String(form.get("image") ?? "").trim();
    // The avatar URL is rendered in <img src> on /admin/users for every
    // admin who opens that page. The CSP already blocks non-https schemes,
    // but any https origin passes it — so an unvalidated value lets any
    // account plant a tracking pixel that leaks admins' IPs when the users
    // list renders. Require https and a sane length; empty clears.
    if (image && (!image.startsWith("https://") || image.length > 2048)) {
      return {
        ok: false,
        error: "Avatar must be an https:// URL (or blank to clear it).",
      };
    }

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
