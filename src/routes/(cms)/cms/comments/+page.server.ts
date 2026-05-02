import { error, fail, redirect } from "@sveltejs/kit";
import { canManageTaxonomy } from "$lib/server/auth/permissions";
import { logAudit, type AuditAction } from "$lib/server/audit";
import type { CommentStatus } from "$lib/server/content/types";
import type { Actions, PageServerLoad } from "./$types";

const PAGE_SIZE = 50;

const VALID_STATUSES: CommentStatus[] = [
  "pending",
  "approved",
  "spam",
  "archived",
];

/**
 * `/cms/comments` — moderation queue (v2.0c). Editor+ only.
 *
 * Filtered by status via `?status=…`; defaults to `pending` so
 * editors land on the work-to-do view. Resolves articleId → article
 * title in one batch so each row can show a clickable title.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageTaxonomy(locals.user)) {
    throw error(403, "Editors and above can moderate comments.");
  }

  const statusParam = url.searchParams.get("status") ?? "pending";
  const status: CommentStatus = (VALID_STATUSES as string[]).includes(
    statusParam,
  )
    ? (statusParam as CommentStatus)
    : "pending";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  const comments = await locals.content.listComments({
    status,
    page,
    limit: PAGE_SIZE + 1,
  });
  const hasNext = comments.length > PAGE_SIZE;
  const items = comments.slice(0, PAGE_SIZE);

  // Resolve article ids → { slug, title } in parallel for the row
  // labels. De-duped so we never fetch the same article twice on a
  // page where one article has many comments.
  const articleIds = [...new Set(items.map((c) => c.articleId))];
  const articleEntries = await Promise.all(
    articleIds.map((id) => locals.content.getArticle(id)),
  );
  const articleById = new Map<string, { slug: string; title: string }>();
  for (const a of articleEntries) {
    if (!a) continue;
    articleById.set(a.id, {
      slug: a.slug,
      title:
        a.localizations.en?.title ??
        a.localizations.th?.title ??
        a.slug,
    });
  }

  // Counts for the status tabs so the editor sees the workload at
  // a glance. Pending count also feeds the sidebar badge.
  const pendingCount = await locals.content.countPendingComments();

  return {
    items,
    articleById: Object.fromEntries(articleById),
    status,
    page,
    hasPrev: page > 1,
    hasNext,
    pendingCount,
  };
};

export const actions: Actions = {
  setStatus: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    const next = String(fd.get("status") ?? "") as CommentStatus;
    if (!id || !VALID_STATUSES.includes(next)) {
      return fail(400, { error: "Bad request" });
    }
    const before = await locals.content.getComment(id);
    if (!before) return fail(404, { error: "Comment not found" });
    await locals.content.updateComment(id, {
      status: next,
      moderatedBy: locals.user.id,
    });
    if (platform?.env?.DB) {
      const action: AuditAction =
        next === "approved"
          ? "comment.approve"
          : next === "spam"
            ? "comment.spam"
            : next === "archived"
              ? "comment.archive"
              : "comment.create";
      await logAudit(platform.env.DB, locals.user.id, action, id, {
        from: before.status,
        to: next,
      });
    }
    return { ok: true };
  },

  delete: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/cms/login");
    if (!canManageTaxonomy(locals.user)) {
      return fail(403, { error: "Forbidden" });
    }
    const fd = await request.formData();
    const id = String(fd.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing comment id" });
    const before = await locals.content.getComment(id);
    if (!before) return fail(404, { error: "Comment not found" });
    await locals.content.deleteComment(id);
    if (platform?.env?.DB) {
      await logAudit(
        platform.env.DB,
        locals.user.id,
        "comment.delete",
        id,
        { articleId: before.articleId },
      );
    }
    return { ok: true };
  },
};
