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
  // Auth: author+ may upload. (No surface gate — `/api/*` is shared between
  // surfaces under path-prefix routing; the auth check above is the real gate.
  // Pre-v1.1 this also checked `locals.subdomain === "cms"` because the CMS
  // ran on its own host; with path-prefix routing every `/api/*` request
  // classifies as the `www` surface, so that check 404'd every upload.)
  if (!locals.user) throw error(401, "Not authenticated");
  if (!hasRole(locals.user, "author")) throw error(403, "Forbidden");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw error(400, "Expected multipart/form-data");
  }

  const form = await request.formData();
  const file = form.get("file");
  const altText = String(form.get("altText") ?? "").trim() || undefined;
  const folderRaw = String(form.get("folderId") ?? "").trim();
  /** Empty folder field = root. v1.7 media folders. */
  const folderId = folderRaw === "" ? null : folderRaw;

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
    folderId,
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
