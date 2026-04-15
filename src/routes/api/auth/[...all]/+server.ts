import type { RequestHandler } from "./$types";
import { validatePlatformEnv } from "$lib/server/config/platform-status";
import { createAuth } from "$lib/server/auth";

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

  const auth = createAuth(env.DB, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
  });

  return auth.handler(request);
};

export const GET = handleAuth;
export const POST = handleAuth;
