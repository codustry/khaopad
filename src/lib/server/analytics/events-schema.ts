/**
 * Analytics events table — the v3.3 addition.
 *
 * One row per tracked event. `properties` + `context` stored as JSON
 * strings so plugin events don't need a schema migration. The
 * `(name, ts)` and `(sessionId, ts)` indexes cover the two hot
 * query paths: per-event aggregates + per-session funnels.
 *
 * Retention: 90-day sliding window enforced by a scheduled Worker
 * cron (deferred to a follow-up sub-PR; the schema doesn't need
 * a partition column, we just DELETE WHERE ts < now-90d).
 *
 * Separate from the v1.8 `analytics` table (which is coarse page-
 * view aggregates only). We keep both — the old table remains the
 * fast path for "how many pageviews yesterday", the new table is
 * for anything more granular.
 */
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    /** Event name from the CanonicalEvent catalog (or plugin-registered name). */
    name: text("name").notNull(),
    /** JSON blob of event-specific properties. */
    propertiesJson: text("properties_json").notNull().default("{}"),
    /** JSON blob of automatic context (path, session, locale, utm, etc.). */
    contextJson: text("context_json").notNull().default("{}"),
    /** ISO datetime — server clock, not client's. */
    ts: text("ts").notNull(),
    /** Denormalized from context for indexed filtering. */
    sessionId: text("session_id").notNull(),
    /** Denormalized from context. Null for anonymous events. */
    userId: text("user_id"),
    /**
     * Denormalized from properties.articleId for the per-article
     * dashboard. Populated by track() when the property exists;
     * duplicates the JSON blob but is the join key for aggregation.
     */
    articleId: text("article_id"),
    /** Same pattern for shop plugin's per-product dashboard. */
    productId: text("product_id"),
  },
  (t) => ({
    nameTsIdx: index("events_name_ts_idx").on(t.name, t.ts),
    sessionTsIdx: index("events_session_ts_idx").on(t.sessionId, t.ts),
    articleTsIdx: index("events_article_ts_idx").on(t.articleId, t.ts),
    productTsIdx: index("events_product_ts_idx").on(t.productId, t.ts),
  }),
);

export type EventRow = typeof events.$inferSelect;
