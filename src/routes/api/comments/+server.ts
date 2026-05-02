import { error, json } from "@sveltejs/kit";
import {
  HONEYPOT_FIELD,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_SECONDS,
  hashIp,
} from "$lib/server/forms";
import { logAudit } from "$lib/server/audit";
import { commentsAllowedForArticle } from "$lib/server/comments";
import type { RequestHandler } from "./$types";

const MAX_NAME = 80;
const MAX_EMAIL = 254;
const MAX_BODY = 4000;

/**
 * POST /api/comments
 *
 * Public comment-submission endpoint (v2.0c). Reuses the v2.0a
 * machinery: honeypot field (`_hp`) + per-IP-hash rate limit. Comments
 * land in `pending` status and require editor approval before they
 * render publicly.
 *
 * Returns:
 *   201 + { ok: true, status: "pending" } on success
 *   400 on validation failure (incl. honeypot)
 *   404 when the article doesn't exist
 *   410 when comments are disabled for this article
 *   429 on rate limit
 */
export const POST: RequestHandler = async ({
  request,
  locals,
  platform,
  getClientAddress,
}) => {
  let payload: Record<string, FormDataEntryValue>;
  try {
    const fd = await request.formData();
    payload = Object.fromEntries(fd.entries());
  } catch {
    throw error(400, "Could not parse form body");
  }

  // Honeypot. Bots tend to fill every field; humans leave the hidden one
  // empty.
  const hp = payload[HONEYPOT_FIELD];
  if (typeof hp === "string" && hp.trim() !== "") {
    throw error(400, "Submission rejected.");
  }

  const articleId = String(payload.article_id ?? "").trim();
  const authorName = String(payload.name ?? "").trim();
  const authorEmail = String(payload.email ?? "").trim();
  const body = String(payload.body ?? "").trim();

  if (!articleId) throw error(400, "Missing article id.");
  if (!authorName) throw error(400, "Name is required.");
  if (!authorEmail || !/.+@.+\..+/.test(authorEmail)) {
    throw error(400, "A valid email is required.");
  }
  if (!body) throw error(400, "Comment body is required.");
  if (authorName.length > MAX_NAME) throw error(400, "Name too long.");
  if (authorEmail.length > MAX_EMAIL) throw error(400, "Email too long.");
  if (body.length > MAX_BODY)
    throw error(400, `Comment too long (max ${MAX_BODY} chars).`);

  // Verify the article exists AND comments are allowed under the dual
  // toggle (site-wide commentsEnabled + per-article commentsMode).
  const article = await locals.content.getArticle(articleId);
  if (!article) throw error(404, "Article not found");
  if (article.status !== "published") throw error(404, "Article not found");

  const settings = await locals.content.getSettings().catch(() => null);
  if (!commentsAllowedForArticle(article, settings)) {
    throw error(410, "Comments are disabled for this article.");
  }

  // Per-IP-hash rate limit. Same threshold as v2.0a (3 / minute).
  let ipHash: string | undefined;
  try {
    const ip = getClientAddress();
    if (ip) ipHash = await hashIp(ip);
  } catch {
    // ignore — getClientAddress may throw in dev preview
  }
  if (ipHash) {
    const recent = await locals.content.countRecentComments(
      article.id,
      ipHash,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (recent >= RATE_LIMIT_MAX_PER_WINDOW) {
      throw error(429, "Too many comments. Try again in a minute.");
    }
  }

  const comment = await locals.content.createComment({
    articleId: article.id,
    authorName,
    authorEmail,
    body,
    ipHash,
  });

  if (platform?.env?.DB) {
    await logAudit(
      platform.env.DB,
      // No actor — public submission. userId is nullable (FK SET NULL).
      null,
      "comment.create",
      comment.id,
      { articleId: article.id, slug: article.slug },
    );
  }

  return json({ ok: true, status: "pending" }, { status: 201 });
};
