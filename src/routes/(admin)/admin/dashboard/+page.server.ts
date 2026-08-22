import { redirect, error } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import * as schema from "$lib/server/content/schema";
import { canManageUsers, hasRole } from "$lib/server/auth/permissions";
import { AnalyticsService } from "$lib/server/analytics";
import { isPluginEnabled } from "$lib/plugins/optional";
import { getEnabledPlugins } from "$lib/server/plugins/enabled";
import { shopOrders } from "$plugins/shop/schema-cart";
import {
  shopInventoryItems,
  shopInventoryLevels,
  shopProductLocalizations,
  shopProductVariants,
} from "$plugins/shop/schema";
import type { PageServerLoad } from "./$types";

const ACTIVITY_LIMIT = 8;
const DRAFTS_LIMIT = 5;
const SCHEDULED_LIMIT = 5;
const TREND_DAYS = 7;

// ── Shop section (#160 C9) ───────────────────────────────────
const SHOP_RECENT_ORDERS = 5;
/** available (on_hand - reserved) at or below this is "low stock". */
const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_LIMIT = 5;

type ShopSection = {
  today: { orders: number; revenueSatang: number };
  week: { orders: number; revenueSatang: number };
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    email: string;
    totalSatang: number;
    financialStatus: string;
    createdAt: string;
  }>;
  lowStock: Array<{
    variantId: string;
    productId: string;
    productTitle: string | null;
    variantTitle: string;
    available: number;
  }>;
};

/**
 * Shop numbers for the dashboard. Admin+ only (mirrors the orders
 * route), and only when the shop plugin is in the enabled set — a
 * site that doesn't sell anything gets no empty commerce section.
 *
 * "Today" is the UTC calendar day: createdAt ISO strings compare
 * lexically, and 'YYYY-MM-DDT…' > 'YYYY-MM-DD'. Cancelled orders are
 * excluded from both counts and revenue.
 */
async function loadShopSection(
  d1: D1Database,
  now: Date,
): Promise<ShopSection> {
  const db = drizzle(d1);
  const todayStart = now.toISOString().slice(0, 10);
  const weekStart = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const notCancelled = ne(shopOrders.status, "cancelled");

  const aggregate = (cutoff: string) =>
    db
      .select({
        orders: sql<number>`count(*)`,
        revenueSatang: sql<number>`coalesce(sum(${shopOrders.totalSatang}), 0)`,
      })
      .from(shopOrders)
      .where(and(gte(shopOrders.createdAt, cutoff), notCancelled))
      .get();

  const available = sql<number>`${shopInventoryLevels.onHand} - ${shopInventoryLevels.reserved}`;

  const [today, week, recentOrders, lowStock] = await Promise.all([
    aggregate(todayStart),
    aggregate(weekStart),
    db
      .select({
        id: shopOrders.id,
        orderNumber: shopOrders.orderNumber,
        email: shopOrders.email,
        totalSatang: shopOrders.totalSatang,
        financialStatus: shopOrders.financialStatus,
        createdAt: shopOrders.createdAt,
      })
      .from(shopOrders)
      .orderBy(desc(shopOrders.createdAt))
      .limit(SHOP_RECENT_ORDERS)
      .all(),
    db
      .select({
        variantId: shopProductVariants.id,
        productId: shopProductVariants.productId,
        productTitle: shopProductLocalizations.title,
        variantTitle: shopProductVariants.titleCached,
        available,
      })
      .from(shopInventoryLevels)
      .innerJoin(
        shopInventoryItems,
        eq(shopInventoryItems.id, shopInventoryLevels.itemId),
      )
      .innerJoin(
        shopProductVariants,
        eq(shopProductVariants.id, shopInventoryItems.variantId),
      )
      .leftJoin(
        shopProductLocalizations,
        and(
          eq(shopProductLocalizations.productId, shopProductVariants.productId),
          eq(shopProductLocalizations.locale, "en"),
        ),
      )
      .where(
        and(
          // Untracked items can't run out; archived variants aren't sold.
          eq(shopInventoryItems.tracked, true),
          eq(shopProductVariants.status, "active"),
          sql`${available} <= ${LOW_STOCK_THRESHOLD}`,
        ),
      )
      .orderBy(available)
      .limit(LOW_STOCK_LIMIT)
      .all(),
  ]);

  return {
    today: {
      orders: today?.orders ?? 0,
      revenueSatang: today?.revenueSatang ?? 0,
    },
    week: {
      orders: week?.orders ?? 0,
      revenueSatang: week?.revenueSatang ?? 0,
    },
    recentOrders,
    lowStock,
  };
}

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
  if (!locals.user) throw redirect(302, "/admin/login");
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
          .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.userId))
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

  // v1.8: top articles + search insights from the analytics tables.
  // Best-effort — empty arrays if the queries fail (fresh install,
  // no data yet, etc.).
  const analytics = new AnalyticsService(platform.env.DB);
  const [topArticles, topSearchTerms, noResultTerms] = await Promise.all([
    analytics.topArticles(30, 5).catch(() => []),
    analytics.topSearchTerms(30, 5).catch(() => []),
    analytics.topNoResultTerms(30, 5).catch(() => []),
  ]);

  // Resolve refIds → article titles + slugs in one pass so the tile
  // can show "Article title" instead of /en/blog/some-slug.
  const articleIdsForResolve = topArticles
    .map((r) => r.refId)
    .filter((x): x is string => Boolean(x));
  const articleById = new Map<
    string,
    { title: string; slug: string; id: string }
  >();
  if (articleIdsForResolve.length > 0) {
    const fetched = await Promise.all(
      articleIdsForResolve.map((id) => locals.content.getArticle(id)),
    );
    for (const a of fetched) {
      if (!a) continue;
      articleById.set(a.id, {
        id: a.id,
        slug: a.slug,
        title:
          a.localizations.en?.title ??
          a.localizations.th?.title ??
          "(untitled)",
      });
    }
  }
  const topArticlesResolved = topArticles.map((r) => {
    const meta = r.refId ? articleById.get(r.refId) : null;
    return {
      path: r.path,
      total: r.total,
      title: meta?.title ?? r.path,
      articleId: meta?.id ?? null,
    };
  });

  // #160 C9: shop section — plugin-gated and admin+ (mirrors the orders
  // route). Best-effort like the analytics tiles: a fresh install
  // without the shop migrations must not take the dashboard down.
  //
  // #193 changed WHICH set this reads. It used to consult
  // the INSTALLED plugin list, which always contains
  // shop, so the gate never fired and every site got a permanent
  // "THB 0.00" revenue panel. It now reads the operator's opt-in set
  // from site settings, the same one that gates the nav and routes.
  const shopEnabled = isPluginEnabled(
    "shop",
    await getEnabledPlugins(locals.content),
  );
  const shop =
    shopEnabled && hasRole(locals.user, "admin")
      ? await loadShopSection(platform.env.DB, now).catch(() => null)
      : null;

  return {
    shop,
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
    topArticles: topArticlesResolved,
    topSearchTerms,
    noResultTerms,
  };
};

function safeParse(s: string): Record<string, unknown> | string {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
