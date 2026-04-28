import { error, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq } from "drizzle-orm";
import * as schema from "$lib/server/content/schema";
import { canManageUsers } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, platform, url }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageUsers(locals.user)) {
    throw error(403, "Only admins and super admins can view the audit log.");
  }
  if (!platform?.env?.DB) throw error(503, "Platform not configured");

  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = drizzle(platform.env.DB, { schema });

  // Left-join the user table so we can show the actor's name + email
  // even when the user is gone (FK is set null on delete).
  const rows = await db
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
    .limit(PAGE_SIZE + 1) // +1 so we know if there's a next page
    .offset(offset)
    .all();

  const hasNext = rows.length > PAGE_SIZE;
  const items = rows.slice(0, PAGE_SIZE).map((r) => ({
    ...r,
    metadata: r.metadata ? safeParse(r.metadata) : null,
  }));

  return {
    items,
    page,
    pageSize: PAGE_SIZE,
    hasPrev: page > 1,
    hasNext,
  };
};

function safeParse(s: string): Record<string, unknown> | string {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
