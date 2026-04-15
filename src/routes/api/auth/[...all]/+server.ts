import type { RequestHandler } from "./$types";
import { createAuth } from "$lib/server/auth";

const handleAuth: RequestHandler = async ({ request, platform }) => {
  const env = platform?.env;
  if (!env) {
    return new Response("Platform bindings not available", { status: 500 });
  }

  const auth = createAuth(env.DB, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
  });

  return auth.handler(request);
};

export const GET = handleAuth;
export const POST = handleAuth;
