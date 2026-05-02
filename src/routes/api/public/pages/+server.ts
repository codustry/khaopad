import { json } from "@sveltejs/kit";
import { authenticate, hasScope } from "$lib/server/api-auth";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, locals }) => {
  const auth = await authenticate(request, locals.content);
  if (!auth.ok || !auth.key) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(auth.key, "pages:read")) {
    return json({ error: "Forbidden — pages:read scope required" }, { status: 403 });
  }
  const pages = await locals.content.listPages({
    status: "published",
    onlyPublished: true,
  });
  return json(
    {
      data: pages.map((p) => ({
        id: p.id,
        slug: p.slug,
        template: p.template,
        publishedAt: p.publishedAt,
        updatedAt: p.updatedAt,
        localizations: p.localizations,
      })),
    },
    { headers: { "cache-control": "public, max-age=120" } },
  );
};
