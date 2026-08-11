/**
 * @khaopad/plugin-shop — retention tables (v3.17, #160 Phase D4).
 * Migration: drizzle/0027_customer_retention.sql.
 */
import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { shopProductVariants } from "./schema";

/**
 * Back-in-stock waitlist. One row per (variant, email) — the UNIQUE
 * index is the dedupe; subscribe uses INSERT OR IGNORE against it.
 * `notifiedAt` marks the restock mail as sent: notify-once is "only
 * rows with notifiedAt IS NULL are ever mailed".
 */
export const backInStockSubscriptions = sqliteTable(
  "back_in_stock_subscriptions",
  {
    id: text("id").primaryKey(),
    variantId: text("variant_id")
      .notNull()
      .references(() => shopProductVariants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    locale: text("locale").notNull().default("en"),
    createdAt: text("created_at").notNull(),
    notifiedAt: text("notified_at"),
  },
  (t) => ({
    variantEmailIdx: uniqueIndex("back_in_stock_variant_email_idx").on(
      t.variantId,
      t.email,
    ),
    variantPendingIdx: index("back_in_stock_variant_pending_idx").on(
      t.variantId,
      t.notifiedAt,
    ),
  }),
);

export type BackInStockSubscription =
  typeof backInStockSubscriptions.$inferSelect;
