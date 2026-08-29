import { createAuth } from "$lib/server/auth";
import { guardedAuthHandler } from "$lib/server/auth/rate-limit-guard";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The token arrives as a query parameter.
 *
 * Better Auth's emailed link points at `/api/auth/reset-password/:token`,
 * which validates the token, then redirects to the `redirectTo` we passed
 * (`/admin/reset-password`) carrying `?token=...` — or `?error=INVALID_TOKEN`
 * when it is expired or already spent. So this page never has to parse the
 * token itself; it only relays what that callback handed it.
 */
export const load: PageServerLoad = async ({ url }) => {
  const token = url.searchParams.get("token") ?? "";
  const error = url.searchParams.get("error") ?? "";
  return { hasToken: token.length > 0, linkError: error };
};

export const actions: Actions = {
  default: async ({ request, platform }) => {
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");

    if (!token) return { ok: false, invalidToken: true };
    // Re-checked server-side even though the page checks it too: the
    // client check is a convenience, not a control. Mirrors the profile
    // action's validation so the two password forms agree on the rules.
    if (newPassword.length < 8) return { ok: false, tooShort: true };
    if (newPassword !== confirmPassword) return { ok: false, mismatch: true };

    if (!platform?.env?.DB) return { ok: false, unavailable: true };

    const auth = createAuth(platform.env.DB, {
      BETTER_AUTH_SECRET: platform.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: platform.env.BETTER_AUTH_URL,
      CONTENT_CACHE: platform.env.CONTENT_CACHE,
    });

    // Through the handler, not auth.api — the limiter lives in the
    // router's onRequest hook, and this endpoint takes an attacker-
    // supplied token, so it must sit behind the same throttle as every
    // other credential path.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.set("content-type", "application/json");
    fwdHeaders.delete("content-length");

    const res = await guardedAuthHandler(
      auth,
      new Request(new URL("/api/auth/reset-password", request.url), {
        method: "POST",
        headers: fwdHeaders,
        body: JSON.stringify({ token, newPassword }),
      }),
      platform.env.AUTH_RATE_LIMITER,
    );

    if (res.status === 429) return { ok: false, rateLimited: true };
    if (!res.ok) {
      // Better Auth answers INVALID_TOKEN for both "expired" and "already
      // used" — single-use is enforced upstream by deleting the
      // verification row when the reset succeeds.
      return { ok: false, invalidToken: true };
    }

    // Sessions elsewhere are already gone: `revokeSessionsOnPasswordReset`
    // makes Better Auth delete every session for this user as part of the
    // reset. Nothing to clean up here — we just send them to sign in.
    return { ok: true };
  },
};
