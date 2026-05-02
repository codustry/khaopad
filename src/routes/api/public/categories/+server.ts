import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, locals }) => {
  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, "categories:read")) {
    return json({ error: "Forbidden — categories:read scope required" }, { status: 403 });
  }
  const categories = await locals.content.listCategories();
  return json(
    { data: categories },
    { headers: { "cache-control": "public, max-age=300" } },
  );
};
