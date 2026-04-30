import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../content/schema";

/**
 * Privacy-friendly server-side analytics (v1.8).
 *
 * Per-day counters keyed on `(date, path)` so a busy site bounds its
 * row count. Every visit increments the day's counter via UPSERT so
 * we don't spawn one row per request. **No IP, no UA, no cookie ID
 * stored** — we only bump a number.
 *
 * Tracking is gated on the visitor's `consent.analytics` flag from
 * the v1.7a cookie banner. No consent → no write, no D1 round-trip.
 *
 * Best-effort: a tracking failure must never break a public page
 * render, so every public method swallows errors.
 */

export type ViewKind = "article" | "page" | "blog_index" | "home" | "other";

export interface TrackOptions {
  path: string;
  kind: ViewKind;
  /** Article or page id, when the path is entity-bound. */
  refId?: string | null;
}

/** UTC date stamp in YYYY-MM-DD format. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Strip trailing slash + querystring; bound the path length. */
function normalizePath(p: string): string {
  let s = p;
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (s.length > 256) s = s.slice(0, 256);
  return s || "/";
}

/**
 * Fire-and-forget bump of the (date, path) counter. Pass through the
 * resolved consent record from `data.consent` — when `analytics` is
 * false we no-op. Returns true when something was written.
 */
export async function trackView(
  db: D1Database,
  opts: TrackOptions,
  consent: { analytics: boolean },
): Promise<boolean> {
  if (!consent.analytics) return false;
  try {
    const date = todayUTC();
    const path = normalizePath(opts.path);
    // SQLite UPSERT: insert with count=1 or bump existing count by 1.
    // ON CONFLICT(date, path) is the composite PK so this is atomic.
    await db
      .prepare(
        `INSERT INTO page_views (date, path, kind, ref_id, count)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(date, path) DO UPDATE SET count = count + 1`,
      )
      .bind(date, path, opts.kind, opts.refId ?? null)
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Log a search query (v1.8). Always written — search itself is
 * functional, not analytics-gated. Anonymized: term + date only.
 * Best-effort: a write failure should not 500 the search page.
 */
export async function logSearch(
  db: D1Database,
  term: string,
  noResults: boolean,
): Promise<void> {
  const trimmed = term.trim().toLowerCase();
  if (!trimmed || trimmed.length > 200) return;
  try {
    await db
      .prepare(
        `INSERT INTO search_log (id, term, no_results, date, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        nanoid(),
        trimmed,
        noResults ? 1 : 0,
        todayUTC(),
        new Date().toISOString(),
      )
      .run();
  } catch {
    // ignore — non-critical
  }
}

// ─── Read paths ─────────────────────────────────────────

export interface TopPathRow {
  path: string;
  kind: ViewKind;
  refId: string | null;
  total: number;
}

export interface SearchTermRow {
  term: string;
  hits: number;
  /** Number of hits where the FTS returned 0 results. */
  noResultHits: number;
}

export interface SparklinePoint {
  date: string;
  count: number;
}

/**
 * Wraps the analytics tables behind a typed D1 surface. All reads
 * are scoped to a `since` cutoff (default 30d) so the dashboard can
 * stay snappy.
 */
export class AnalyticsService {
  private db: DrizzleD1Database<typeof schema>;
  private d1: D1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1, { schema });
    this.d1 = d1;
  }

  /** Top N paths by count over the last `days`. */
  async topPaths(days = 30, limit = 10): Promise<TopPathRow[]> {
    const since = sinceDate(days);
    const rows = await this.db
      .select({
        path: schema.pageViews.path,
        kind: schema.pageViews.kind,
        refId: schema.pageViews.refId,
        total: sql<number>`SUM(${schema.pageViews.count})`,
      })
      .from(schema.pageViews)
      .where(gte(schema.pageViews.date, since))
      .groupBy(schema.pageViews.path, schema.pageViews.kind, schema.pageViews.refId)
      .orderBy(sql`SUM(${schema.pageViews.count}) DESC`)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      path: r.path,
      kind: r.kind as ViewKind,
      refId: r.refId,
      total: Number(r.total ?? 0),
    }));
  }

  /** Top N article paths by count. */
  async topArticles(days = 30, limit = 10): Promise<TopPathRow[]> {
    const since = sinceDate(days);
    const rows = await this.db
      .select({
        path: schema.pageViews.path,
        kind: schema.pageViews.kind,
        refId: schema.pageViews.refId,
        total: sql<number>`SUM(${schema.pageViews.count})`,
      })
      .from(schema.pageViews)
      .where(
        and(
          gte(schema.pageViews.date, since),
          eq(schema.pageViews.kind, "article"),
        ),
      )
      .groupBy(schema.pageViews.path, schema.pageViews.kind, schema.pageViews.refId)
      .orderBy(sql`SUM(${schema.pageViews.count}) DESC`)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      path: r.path,
      kind: r.kind as ViewKind,
      refId: r.refId,
      total: Number(r.total ?? 0),
    }));
  }

  /** Top search terms, ordered by hit count. */
  async topSearchTerms(days = 30, limit = 10): Promise<SearchTermRow[]> {
    const since = sinceDate(days);
    const rows = await this.db
      .select({
        term: schema.searchLog.term,
        hits: sql<number>`COUNT(*)`,
        noResultHits: sql<number>`SUM(CASE WHEN ${schema.searchLog.noResults} THEN 1 ELSE 0 END)`,
      })
      .from(schema.searchLog)
      .where(gte(schema.searchLog.date, since))
      .groupBy(schema.searchLog.term)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      term: r.term,
      hits: Number(r.hits ?? 0),
      noResultHits: Number(r.noResultHits ?? 0),
    }));
  }

  /** Top search terms that returned zero results. */
  async topNoResultTerms(days = 30, limit = 10): Promise<SearchTermRow[]> {
    const since = sinceDate(days);
    const rows = await this.db
      .select({
        term: schema.searchLog.term,
        hits: sql<number>`COUNT(*)`,
      })
      .from(schema.searchLog)
      .where(
        and(
          gte(schema.searchLog.date, since),
          eq(schema.searchLog.noResults, true),
        ),
      )
      .groupBy(schema.searchLog.term)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      term: r.term,
      hits: Number(r.hits ?? 0),
      noResultHits: Number(r.hits ?? 0),
    }));
  }

  /**
   * Per-day series for one path over the last `days`. Returns one
   * point per day in the window, filling 0 for days with no views
   * so the sparkline stays continuous.
   */
  async sparkline(path: string, days = 30): Promise<SparklinePoint[]> {
    const since = sinceDate(days);
    const rows = await this.db
      .select({
        date: schema.pageViews.date,
        count: sql<number>`SUM(${schema.pageViews.count})`,
      })
      .from(schema.pageViews)
      .where(
        and(
          gte(schema.pageViews.date, since),
          eq(schema.pageViews.path, path),
        ),
      )
      .groupBy(schema.pageViews.date)
      .orderBy(desc(schema.pageViews.date))
      .all();
    const byDate = new Map(rows.map((r) => [r.date, Number(r.count)]));
    const out: SparklinePoint[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dateMinusDays(i);
      out.push({ date: d, count: byDate.get(d) ?? 0 });
    }
    return out;
  }

  /** Total views for a single path over the last `days`. */
  async totalViews(path: string, days = 30): Promise<number> {
    const since = sinceDate(days);
    const row = await this.db
      .select({
        total: sql<number>`SUM(${schema.pageViews.count})`,
      })
      .from(schema.pageViews)
      .where(
        and(
          gte(schema.pageViews.date, since),
          eq(schema.pageViews.path, path),
        ),
      )
      .get();
    return Number(row?.total ?? 0);
  }
}

function sinceDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dateMinusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
