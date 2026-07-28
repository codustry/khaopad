/**
 * /admin/hello — reference plugin admin page.
 *
 * Owned by @khaopad/plugin-hello. Contributed via file placement, not
 * Vite magic — plugins in v3.0 drop their route files directly under
 * src/routes/(admin)/admin/<slug>/. When plugins ship as npm packages
 * later (v3.5+), a small post-install step will copy their `routes/`
 * folder here. Same runtime behavior either way.
 */
import { error, redirect, fail } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logAudit } from "$lib/server/audit";
import { helloPings } from "$plugins/hello/schema";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const db = drizzle(env.DB);
  const pings = await db
    .select()
    .from(helloPings)
    .orderBy(desc(helloPings.createdAt))
    .limit(20)
    .all();
  return { pings };
};

export const actions: Actions = {
  ping: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const message = String(fd.get("message") ?? "").trim();
    if (!message) return fail(400, { error: "Message is required" });
    if (message.length > 500) {
      return fail(400, { error: "Message must be 500 chars or fewer" });
    }

    const db = drizzle(env.DB);
    const id = nanoid();
    await db.insert(helloPings).values({
      id,
      message,
      createdAt: new Date().toISOString(),
      userId: locals.user.id,
      count: 1,
    });

    // Uses the audit action registered as a plugin (open string via 1a)
    await logAudit(env.DB, locals.user.id, "hello.pinged", id, { message });

    return { success: true, id };
  },
};
