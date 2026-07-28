/**
 * Schema for @khaopad/plugin-hello.
 *
 * Table naming convention: plugins prefix all tables with their slug
 * (`hello_*`). This is a soft convention — the DB has no enforcement,
 * but it makes cross-plugin table collisions obvious in query logs and
 * keeps `SELECT * FROM sqlite_master` legible for operators.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const helloPings = sqliteTable("hello_pings", {
  id: text("id").primaryKey(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
  userId: text("user_id"),
  count: integer("count").notNull().default(1),
});

export type HelloPing = typeof helloPings.$inferSelect;
