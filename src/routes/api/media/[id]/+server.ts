import { error } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import type { RequestHandler } from "./$types";

/**
 * GET /api/media/[id]
 *
 * Streams the R2 object for the given media id. Public on www (so `<img>` tags
 * in article bodies just work), public on cms (so the library previews work).
 */
export const GET: RequestHandler = async ({ locals, params, setHeaders }) => {
  const record = await locals.media.get(params.id);
  if (!record) throw error(404, "Not found");

  const stream = await locals.media.getFile(record.r2Key);
  if (!stream) throw error(404, "Not found");

  setHeaders({
    "Content-Type": record.mimeType,
    "Content-Length": String(record.size),
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  return new Response(stream);
};

/**
 * DELETE /api/media/[id]
 *
 * Admin+ only. Removes both the R2 object and the metadata row.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, "Not authenticated");
  if (!hasRole(locals.user, "admin")) throw error(403, "Forbidden");
  // No surface gate: `/api/*` classifies as `www` under path-prefix routing
  // (see POST /api/media). The role check above is the real gate.

  const record = await locals.media.get(params.id);
  if (!record) throw error(404, "Not found");

  await locals.media.delete(params.id);
  return new Response(null, { status: 204 });
};
