import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, locals }) => {
  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, "tags:read")) {
    return json({ error: "Forbidden — tags:read scope required" }, { status: 403 });
  }
  const tags = await locals.content.listTags();
  return json(
    { data: tags },
    { headers: { "cache-control": "public, max-age=300" } },
  );
};
