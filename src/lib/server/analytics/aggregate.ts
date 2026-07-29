/**
 * Analytics aggregation queries — powers /admin/articles/[id]/analytics
 * and /admin/shop/products/[id]/analytics dashboards.
 *
 * Every query is bounded (default: 30 days) so a 500k-event table
 * doesn't drag the admin UI. Callers can widen the window when they
 * need historical data; the composite indexes cover both patterns.
 *
 * Response shapes are small + serializable — safe to return from a
 * SvelteKit load function directly.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gte, sql } from "drizzle-orm";
import { events } from "./events-schema";

const DEFAULT_WINDOW_DAYS = 30;

function windowStart(days = DEFAULT_WINDOW_DAYS): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Per-article ────────────────────────────────────────────

export type ArticleAnalytics = {
  articleId: string;
  windowDays: number;
  pageViews: number;
  articleReads: number;
  medianReadTimeMs: number | null;
  scrollDepthBuckets: {
    "0-24": number;
    "25-49": number;
    "50-74": number;
    "75-100": number;
  };
  /**
   * Purchase attribution — orders where document.referrer pointed at
   * this article. Requires the shop product page to have fired
   * product_view with attributedArticleId. v4b MVP: count only;
   * revenue join lands with the dashboard shop-referrer sub-PR.
   */
  attributedPurchases: number;
  /** Top referrer origins for context, capped to 5. */
  topReferrers: Array<{ origin: string; count: number }>;
};

export async function getArticleAnalytics(
  d1: D1Database,
  articleId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<ArticleAnalytics> {
  const db = drizzle(d1);
  const since = windowStart(windowDays);

  // page_view rows for this article (from properties.articleId — the
  // hook-side fire tags them via the URL match on /blog/[slug]).
  // v4b: page_view isn't tagged with articleId yet (hook doesn't
  // resolve slug → id). Rely on article_read for now; add a
  // slug→id map in a follow-up.
  const [readsRow] = await db
    .select({
      total: sql<number>`count(*)`,
      medianReadTimeMs: sql<
        number | null
      >`(SELECT AVG(CAST(json_extract(properties_json, '$.readTimeMs') AS INTEGER))
         FROM events
         WHERE name = 'article_read'
           AND article_id = ${articleId}
           AND ts >= ${since})`,
    })
    .from(events)
    .where(
      and(
        eq(events.name, "article_read"),
        eq(events.articleId, articleId),
        gte(events.ts, since),
      ),
    )
    .all();

  // Scroll depth histogram.
  const scrollRows = await db
    .select({
      scrollPct: sql<
        number | null
      >`CAST(json_extract(properties_json, '$.scrollPct') AS INTEGER)`,
    })
    .from(events)
    .where(
      and(
        eq(events.name, "article_read"),
        eq(events.articleId, articleId),
        gte(events.ts, since),
      ),
    )
    .all();
  const buckets = { "0-24": 0, "25-49": 0, "50-74": 0, "75-100": 0 };
  for (const r of scrollRows) {
    const pct = r.scrollPct ?? 0;
    if (pct < 25) buckets["0-24"]++;
    else if (pct < 50) buckets["25-49"]++;
    else if (pct < 75) buckets["50-74"]++;
    else buckets["75-100"]++;
  }

  // Attributed purchases — purchases whose properties.attributedArticleId
  // matches this article.
  const [attributedRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(events)
    .where(
      and(
        eq(events.name, "purchase"),
        gte(events.ts, since),
        sql`json_extract(properties_json, '$.attributedArticleId') = ${articleId}`,
      ),
    )
    .all();

  // Top referrer origins from article_read context.
  const referrerRows = await db
    .select({
      origin: sql<
        string | null
      >`json_extract(context_json, '$.referrer')`,
      count: sql<number>`count(*)`,
    })
    .from(events)
    .where(
      and(
        eq(events.name, "article_read"),
        eq(events.articleId, articleId),
        gte(events.ts, since),
      ),
    )
    .groupBy(sql`json_extract(context_json, '$.referrer')`)
    .orderBy(sql`count(*) DESC`)
    .limit(20)
    .all();
  const topReferrers: Array<{ origin: string; count: number }> = [];
  for (const r of referrerRows) {
    if (!r.origin) continue;
    try {
      const host = new URL(r.origin).host;
      topReferrers.push({ origin: host, count: r.count });
      if (topReferrers.length >= 5) break;
    } catch {
      // Skip malformed referrers
    }
  }

  return {
    articleId,
    windowDays,
    // page_view without slug→id map is 0 for now; kept in the shape
    // so the dashboard doesn't have to change when we wire it up.
    pageViews: 0,
    articleReads: readsRow?.total ?? 0,
    medianReadTimeMs: readsRow?.medianReadTimeMs
      ? Math.round(readsRow.medianReadTimeMs)
      : null,
    scrollDepthBuckets: buckets,
    attributedPurchases: attributedRow?.total ?? 0,
    topReferrers,
  };
}

// ─── Per-product ────────────────────────────────────────────

export type ProductAnalytics = {
  productId: string;
  windowDays: number;
  productViews: number;
  addsToCart: number;
  purchases: number;
  purchaseRate: number; // adds_to_cart → purchase conversion, 0..1
  addToCartRate: number; // product_view → add_to_cart conversion, 0..1
  totalRevenueSatang: number;
};

export async function getProductAnalytics(
  d1: D1Database,
  productId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<ProductAnalytics> {
  const db = drizzle(d1);
  const since = windowStart(windowDays);

  const [views] = await db
    .select({ total: sql<number>`count(*)` })
    .from(events)
    .where(
      and(
        eq(events.name, "product_view"),
        eq(events.productId, productId),
        gte(events.ts, since),
      ),
    )
    .all();

  const [addsToCart] = await db
    .select({ total: sql<number>`count(*)` })
    .from(events)
    .where(
      and(
        eq(events.name, "add_to_cart"),
        eq(events.productId, productId),
        gte(events.ts, since),
      ),
    )
    .all();

  // Purchase count + revenue — sum totalSatang for orders containing
  // this productId. v4b MVP: we don't yet emit purchase.productId
  // (purchase context is order-level). Placeholder 0 until the
  // per-line purchase event lands in 4c.
  const purchases = 0;
  const revenue = 0;

  const productViews = views?.total ?? 0;
  const carts = addsToCart?.total ?? 0;
  return {
    productId,
    windowDays,
    productViews,
    addsToCart: carts,
    purchases,
    purchaseRate: carts > 0 ? purchases / carts : 0,
    addToCartRate: productViews > 0 ? carts / productViews : 0,
    totalRevenueSatang: revenue,
  };
}
