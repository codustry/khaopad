import { error, redirect } from "@sveltejs/kit";
import {
  hasAnySuperAdmin,
  promoteToSuperAdmin,
} from "$lib/server/auth/bootstrap";
import { createAuth } from "$lib/server/auth";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.platformReady || !platform?.env) {
    throw error(503, "Platform not configured");
  }
  if (await hasAnySuperAdmin(platform.env.DB)) {
    // Already bootstrapped — lock the route.
    throw error(403, "Sign-up is closed. Ask an admin to invite you.");
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, platform }) => {
    if (!platform?.env) {
      throw error(503, "Platform not configured");
    }
    if (await hasAnySuperAdmin(platform.env.DB)) {
      throw error(403, "Sign-up is closed.");
    }

    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (!name || !email || password.length < 8) {
      return {
        ok: false,
        error:
          "Name, email, and a password of at least 8 characters are required.",
      };
    }

    const auth = createAuth(platform.env.DB, {
      BETTER_AUTH_SECRET: platform.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: platform.env.BETTER_AUTH_URL,
    });

    // Better Auth creates the user + credential row in one batched call.
    // Pass `headers` so the auto-sign-in path has request context for the
    // session cookie write.
    let result;
    try {
      result = await auth.api.signUpEmail({
        body: { name, email, password },
        headers: request.headers,
        asResponse: false,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Sign-up failed",
      };
    }

    const userId = (result as { user?: { id?: string } } | undefined)?.user?.id;
    if (!userId) {
      return { ok: false, error: "Sign-up returned no user" };
    }

    // Promote to super_admin because this is the very first account.
    await promoteToSuperAdmin(platform.env.DB, userId);

    throw redirect(302, "/cms/login?bootstrapped=1");
  },
};
