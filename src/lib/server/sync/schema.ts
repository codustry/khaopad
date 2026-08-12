/**
 * Sync audit log (0030, #160 Phase E).
 *
 * Append-only record of every item processed by a commerce-network
 * sync endpoint, in either direction. Deliberately source-generic
 * (`source` = 'tonbab' today; marketplaces later) so one table serves
 * the whole network. Read by /admin/settings/connections for the live
 * pairing-status panel.
 */
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const syncLog = sqliteTable(
  "sync_log",
  {
    id: text("id").primaryKey(),
    /** Origin/peer system, e.g. 'tonbab'. */
    source: text("source").notNull(),
    /** 'inbound' (pushed to us) or 'outbound' (we pushed). */
    direction: text("direction", {
      enum: ["inbound", "outbound"],
    }).notNull(),
    /** Peer's id for the entity (Tonbab order id). Null for batch-level rows. */
    externalId: text("external_id"),
    /** What was attempted: 'upsert', 'transition:fulfilled', ... */
    action: text("action").notNull(),
    /** 'created' | 'replayed' | 'applied' | 'skipped' | 'error'. */
    result: text("result").notNull(),
    /** Free-text detail — error message, skip reason, order number. */
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sourceCreatedIdx: index("sync_log_source_created_idx").on(
      t.source,
      t.createdAt,
    ),
  }),
);

export type SyncLogRow = typeof syncLog.$inferSelect;
