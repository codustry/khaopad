import type { RequestHandler } from "./$types";
import { validatePlatformEnv } from "$lib/server/config/platform-status";
import { createAuth } from "$lib/server/auth";
import { guardedAuthHandler } from "$lib/server/auth/rate-limit-guard";

const handleAuth: RequestHandler = async ({ request, platform }) => {
  const env = platform?.env;
  const check = validatePlatformEnv(env);
  if (!check.ok) {
    return new Response(
      JSON.stringify({
        error: "configuration_required",
        message: check.message,
        missing: check.missing,
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
  if (!env) {
    return new Response(
      JSON.stringify({
        error: "configuration_required",
        message: "Cloudflare bindings are not available.",
        missing: ["platform.env"],
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  const auth = createAuth(env.DB, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    RESEND_API_KEY: env.RESEND_API_KEY,
    RESEND_FROM: env.RESEND_FROM,
    CONTENT_CACHE: env.CONTENT_CACHE,
  });

  return guardedAuthHandler(auth, request, platform?.env?.AUTH_RATE_LIMITER);
};

export const GET = handleAuth;
export const POST = handleAuth;
