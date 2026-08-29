/**
 * Content-scale counts for the telemetry ping (#199).
 *
 * These are read as exact numbers here and immediately bucketed by the
 * caller — the exact value never leaves the Worker. Splitting the read
 * from the bucketing keeps the D1 query trivial and lets the payload
 * test assert on the bucketing in isolation.
 *
 * Never throws: any failure degrades to 0, which buckets to "0". A
 * telemetry read must not be able to break the cron tick.
 */
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import * as schema from "../content/schema";

export interface ContentCounts {
  articles: number;
  pages: number;
  users: number;
}

async function countRows(
  db: ReturnType<typeof drizzle>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
): Promise<number> {
  try {
    const row = await db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .get();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function readContentCounts(
  d1: D1Database,
): Promise<ContentCounts> {
  try {
    const db = drizzle(d1, { schema });
    const [articles, pages, users] = await Promise.all([
      countRows(db, schema.articles),
      countRows(db, schema.pages),
      countRows(db, schema.users),
    ]);
    return { articles, pages, users };
  } catch {
    return { articles: 0, pages: 0, users: 0 };
  }
}
