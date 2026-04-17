/**
 * Bootstrap helpers — decide whether the public `/signup` route is still open.
 *
 * Sign-up is a one-shot: the very first caller becomes `super_admin` and the
 * route locks forever. After that, admins create users via the (future) `/users`
 * management screen.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import * as schema from "../content/schema";

export async function hasAnySuperAdmin(d1: D1Database): Promise<boolean> {
  const db = drizzle(d1, { schema });
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.users)
    .where(eq(schema.users.role, "super_admin"))
    .get();
  return (row?.count ?? 0) > 0;
}

export async function promoteToSuperAdmin(
  d1: D1Database,
  userId: string,
): Promise<void> {
  const db = drizzle(d1, { schema });
  const now = new Date().toISOString();
  await db
    .update(schema.users)
    .set({ role: "super_admin", updatedAt: now })
    .where(eq(schema.users.id, userId));
}
