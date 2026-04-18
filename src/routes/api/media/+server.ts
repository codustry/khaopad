import { error, json } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import type { RequestHandler } from "./$types";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_PREFIXES = ["image/", "video/", "audio/", "application/pdf"];

/**
 * POST /api/media
 *
 * CMS-only (author+). Accepts multipart/form-data with a `file` part and
 * optional `altText`. Stores the blob in R2 and metadata in D1, returns the
 * resulting MediaRecord.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  // Auth: author+ may upload.
  if (!locals.user) throw error(401, "Not authenticated");
  if (!hasRole(locals.user, "author")) throw error(403, "Forbidden");

  // We only allow uploads on the CMS subdomain — the www surface is read-only.
  if (locals.subdomain !== "cms") {
    throw error(404, "Not found");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw error(400, "Expected multipart/form-data");
  }

  const form = await request.formData();
  const file = form.get("file");
  const altText = String(form.get("altText") ?? "").trim() || undefined;

  if (!(file instanceof File)) {
    throw error(400, "Missing `file` field");
  }
  if (file.size === 0) {
    throw error(400, "File is empty");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw error(413, `File exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_PREFIXES.some((p) => mime.startsWith(p))) {
    throw error(415, `Unsupported content type: ${mime}`);
  }

  const data = await file.arrayBuffer();
  const filename = sanitizeFilename(file.name || "upload.bin");

  const record = await locals.media.upload({
    filename,
    mimeType: mime,
    data,
    altText,
    uploadedBy: locals.user.id,
  });

  return json(record, { status: 201 });
};

/**
 * GET /api/media
 *
 * Authenticated list for the CMS media library.
 */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, "Not authenticated");
  const items = await locals.media.list();
  return json({ items });
};

/** Strip path separators and control chars; keep extension. */
function sanitizeFilename(name: string): string {
  const base = name
    .replace(/[\\/]/g, "_")
    .replace(/[^\w.\-+ ]/g, "_")
    .trim();
  return base || "upload.bin";
}
