import { redirect, error } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq, and, gte } from "drizzle-orm";
import * as schema from "$lib/server/content/schema";
import { canManageUsers } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

const ACTIVITY_LIMIT = 8;
const DRAFTS_LIMIT = 5;
const SCHEDULED_LIMIT = 5;
const TREND_DAYS = 7;

/**
 * Dashboard load. Rich enough to be useful, cheap enough to render fast.
 *
 * D1 queries (in parallel):
 *   1. listArticles({limit:1})           — total + first row
 *   2. listArticles({status:'published', limit:1}) — published total
 *   3. listArticles({status:'draft', limit:DRAFTS_LIMIT})  — recent drafts
 *   4. listArticles({status:'published', limit: 200})      — for scheduled filter
 *   5. media.list()                                         — count + recent
 *   6. count(users)                                         — direct drizzle
 *   7. count(articles created in last TREND_DAYS days)      — direct drizzle
 *   8. audit_log left-joined with users (admin+ only)       — direct drizzle
 *
 * Author/editor see everything except activity feed (admin+ only).
 */
export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!platform?.env?.DB) throw error(503, "Platform not configured");

  const db = drizzle(platform.env.DB, { schema });
  const now = new Date();
  const trendCutoff = new Date(
    now.getTime() - TREND_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const showActivity = canManageUsers(locals.user);

  const [
    allArticlesPage,
    publishedPage,
    draftsPage,
    publishedForSchedule,
    media,
    usersCount,
    recentArticlesCount,
    activityRows,
  ] = await Promise.all([
    locals.content.listArticles({ limit: 1 }),
    locals.content.listArticles({ status: "published", limit: 1 }),
    locals.content.listArticles({ status: "draft", limit: DRAFTS_LIMIT }),
    // Pull a window of published articles, then filter in-memory for
    // future publishedAt. Cheap as long as the published count stays
    // moderate; revisit if a single instance ever holds 10k+ articles.
    locals.content.listArticles({ status: "published", limit: 200 }),
    locals.media.list(),
    db
      .select({ count: schema.users.id })
      .from(schema.users)
      .all()
      .then((rows) => rows.length),
    db
      .select({ id: schema.articles.id })
      .from(schema.articles)
      .where(gte(schema.articles.createdAt, trendCutoff))
      .all()
      .then((rows) => rows.length),
    showActivity
      ? db
          .select({
            id: schema.auditLog.id,
            userId: schema.auditLog.userId,
            action: schema.auditLog.action,
            entityType: schema.auditLog.entityType,
            entityId: schema.auditLog.entityId,
            metadata: schema.auditLog.metadata,
            createdAt: schema.auditLog.createdAt,
            actorName: schema.users.name,
            actorEmail: schema.users.email,
          })
          .from(schema.auditLog)
          .leftJoin(
            schema.users,
            eq(schema.users.id, schema.auditLog.userId),
          )
          .orderBy(desc(schema.auditLog.createdAt))
          .limit(ACTIVITY_LIMIT)
          .all()
      : Promise.resolve(
          [] as Array<{
            id: string;
            userId: string | null;
            action: string;
            entityType: string;
            entityId: string;
            metadata: string | null;
            createdAt: string;
            actorName: string | null;
            actorEmail: string | null;
          }>,
        ),
  ]);

  const nowIso = now.toISOString();
  const scheduled = publishedForSchedule.items
    .filter((a) => a.publishedAt && a.publishedAt > nowIso)
    .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""))
    .slice(0, SCHEDULED_LIMIT);

  const draftsTotal = draftsPage.total;
  const allTotal = allArticlesPage.total;
  const publishedTotal = publishedPage.total;
  const scheduledTotal = publishedForSchedule.items.filter(
    (a) => a.publishedAt && a.publishedAt > nowIso,
  ).length;

  // i18n coverage: of the published articles in our window, how many
  // have an `en` localization, and how many have `th`? Useful nudge for
  // editors to finish translations.
  const publishedItems = publishedForSchedule.items;
  const enCount = publishedItems.filter((a) => a.localizations.en).length;
  const thCount = publishedItems.filter((a) => a.localizations.th).length;

  return {
    stats: {
      total: allTotal,
      published: publishedTotal,
      drafts: draftsTotal,
      scheduled: scheduledTotal,
      media: media.length,
      users: usersCount,
      newThisWeek: recentArticlesCount,
    },
    drafts: draftsPage.items.map((a) => ({
      id: a.id,
      title:
        a.localizations.en?.title ?? a.localizations.th?.title ?? "(untitled)",
      updatedAt: a.updatedAt,
      slug: a.slug,
    })),
    scheduled: scheduled.map((a) => ({
      id: a.id,
      title:
        a.localizations.en?.title ?? a.localizations.th?.title ?? "(untitled)",
      publishedAt: a.publishedAt!,
      slug: a.slug,
    })),
    coverage: {
      total: publishedItems.length,
      en: enCount,
      th: thCount,
    },
    activity: activityRows.map((r) => ({
      ...r,
      metadata: r.metadata ? safeParse(r.metadata) : null,
    })),
    showActivity,
  };
};

function safeParse(s: string): Record<string, unknown> | string {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
