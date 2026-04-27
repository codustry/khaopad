import { error, fail, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { count, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "$lib/server/content/schema";
import { canManageUser, canManageUsers } from "$lib/server/auth/permissions";
import type { UserRole } from "$lib/server/auth/types";
import type { Actions, PageServerLoad } from "./$types";

const VALID_ROLES = [
  "super_admin",
  "admin",
  "editor",
  "author",
] as const satisfies readonly UserRole[];

function isValidRole(value: unknown): value is UserRole {
  return (
    typeof value === "string" &&
    (VALID_ROLES as readonly string[]).includes(value)
  );
}

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/cms/login");
  if (!canManageUsers(locals.user)) {
    throw error(403, "Only admins and super admins can manage users.");
  }
  if (!platform?.env?.DB) throw error(503, "Platform not configured");

  const db = drizzle(platform.env.DB, { schema });
  const items = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.users.role,
      createdAt: schema.users.createdAt,
      image: schema.users.image,
    })
    .from(schema.users)
    .orderBy(desc(schema.users.createdAt));

  return {
    items,
    me: {
      id: locals.user.id,
      role: locals.user.role,
    },
  };
};

/** Run the action body inside a "must be an admin+" gate. */
function requireUserManager(locals: App.Locals) {
  if (!locals.user) throw error(401, "Not authenticated");
  if (!canManageUsers(locals.user)) {
    throw error(403, "Only admins and super admins can manage users.");
  }
}

/** Read a user row by id. Returns null when not found. */
async function findUser(d1: D1Database, id: string) {
  const db = drizzle(d1, { schema });
  const row = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .get();
  return row ?? null;
}

/** Count remaining super_admins. Used to block the last-super-admin demotion. */
async function countSuperAdmins(d1: D1Database): Promise<number> {
  const db = drizzle(d1, { schema });
  const row = await db
    .select({ n: count() })
    .from(schema.users)
    .where(eq(schema.users.role, "super_admin"))
    .get();
  return row?.n ?? 0;
}

/** Best-effort audit-log entry — never throws into the action flow. */
async function logAudit(
  d1: D1Database,
  actorId: string | null,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  try {
    const db = drizzle(d1, { schema });
    await db.insert(schema.auditLog).values({
      id: nanoid(),
      userId: actorId,
      action,
      entityType: "user",
      entityId,
      metadata: JSON.stringify(metadata),
    });
  } catch {
    // Audit logging is best-effort. A missing row is better than a 500.
  }
}

export const actions: Actions = {
  /**
   * Change a user's role. Enforces every guard in the spec:
   *   - Acting user is an admin+
   *   - Cannot change own role
   *   - Cannot demote the last super_admin
   *   - Plain admins cannot touch other admins or super_admins
   */
  updateRole: async ({ request, locals, platform }) => {
    requireUserManager(locals);
    if (!platform?.env?.DB) throw error(503, "Platform not configured");

    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    const role = String(form.get("role") ?? "").trim();

    if (!id) return fail(400, { error: "Missing user id." });
    if (!isValidRole(role)) {
      return fail(400, { error: `Invalid role: ${role}` });
    }

    const target = await findUser(platform.env.DB, id);
    if (!target) return fail(404, { error: "User not found." });

    if (!canManageUser(locals.user, target)) {
      return fail(403, {
        error:
          locals.user!.id === target.id
            ? "You can't change your own role."
            : "You can't change this user's role.",
      });
    }

    // Last-super-admin guard: only relevant when *demoting* a super_admin.
    if (target.role === "super_admin" && role !== "super_admin") {
      const remaining = await countSuperAdmins(platform.env.DB);
      if (remaining <= 1) {
        return fail(400, {
          error: "At least one super admin must remain.",
        });
      }
    }

    const db = drizzle(platform.env.DB, { schema });
    const now = new Date().toISOString();
    await db
      .update(schema.users)
      .set({ role, updatedAt: now })
      .where(eq(schema.users.id, id));

    await logAudit(platform.env.DB, locals.user!.id, "user.role_change", id, {
      from: target.role,
      to: role,
    });
    return { ok: true };
  },

  /**
   * Hard-delete a user. Sessions and accounts cascade automatically (FK
   * `onDelete: cascade`). Articles authored by this user are kept; the
   * `authorId` foreign key uses `onDelete: NO ACTION` so the database
   * blocks the delete unless authorship is reassigned. We surface that as
   * a 400 instead of a 500.
   */
  delete: async ({ request, locals, platform }) => {
    requireUserManager(locals);
    if (!platform?.env?.DB) throw error(503, "Platform not configured");

    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    if (!id) return fail(400, { error: "Missing user id." });

    const target = await findUser(platform.env.DB, id);
    if (!target) return fail(404, { error: "User not found." });

    if (!canManageUser(locals.user, target)) {
      return fail(403, {
        error:
          locals.user!.id === target.id
            ? "You can't remove your own account."
            : "You can't remove this user.",
      });
    }

    if (target.role === "super_admin") {
      const remaining = await countSuperAdmins(platform.env.DB);
      if (remaining <= 1) {
        return fail(400, {
          error: "At least one super admin must remain.",
        });
      }
    }

    try {
      const db = drizzle(platform.env.DB, { schema });
      await db.delete(schema.users).where(eq(schema.users.id, id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Foreign-key block: this user still authors articles.
      if (/FOREIGN KEY|constraint/i.test(msg)) {
        return fail(400, {
          error:
            "This user still authors articles. Reassign or delete those articles before removing the account.",
        });
      }
      return fail(500, { error: msg });
    }

    await logAudit(platform.env.DB, locals.user!.id, "user.delete", id, {
      role: target.role,
    });
    return { ok: true };
  },
};
