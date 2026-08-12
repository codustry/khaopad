import { error, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { desc, eq, sql } from "drizzle-orm";
import { canManageSettings } from "$lib/server/auth/permissions";
import { getSecrets } from "$lib/server/secrets/service";
import { syncLog } from "$lib/server/sync/schema";
import type { PageServerLoad } from "./$types";

/**
 * /admin/settings/connections — commerce-network pairing (#160 Phase E).
 *
 * Admin+ (canManageSettings): this page carries the pairing GUIDE and
 * live status only. The secret VALUES are pasted on
 * /admin/settings/secrets, which stays super_admin-gated — so this page
 * reports configured/not-configured booleans, never previews.
 */
export const load: PageServerLoad = async ({ locals, platform, url }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!canManageSettings(locals.user)) {
    throw error(403, "Admins only");
  }

  const endpointUrl = `${url.origin}/api/sync/tonbab`;

  const env = platform?.env;
  if (!env?.DB) {
    return {
      endpointUrl,
      platformReady: false,
      apiKeyConfigured: false,
      webhookSecretConfigured: false,
      lastSync: null,
      totalCount: 0,
      errorCount: 0,
    };
  }

  // Booleans only — never a value or preview (see docblock).
  const secrets = await getSecrets(env, [
    "TONBAB_API_KEY",
    "TONBAB_WEBHOOK_SECRET",
  ]);

  const db = drizzle(env.DB);
  const [lastRows, countRows] = await Promise.all([
    db
      .select()
      .from(syncLog)
      .where(eq(syncLog.source, "tonbab"))
      .orderBy(desc(syncLog.createdAt), desc(syncLog.id))
      .limit(1)
      .all(),
    db
      .select({
        total: sql<number>`COUNT(*)`,
        errors: sql<number>`SUM(CASE WHEN ${syncLog.result} = 'error' THEN 1 ELSE 0 END)`,
      })
      .from(syncLog)
      .where(eq(syncLog.source, "tonbab"))
      .all(),
  ]);

  const last = lastRows[0] ?? null;
  return {
    endpointUrl,
    platformReady: true,
    apiKeyConfigured: Boolean(secrets.TONBAB_API_KEY),
    webhookSecretConfigured: Boolean(secrets.TONBAB_WEBHOOK_SECRET),
    lastSync: last
      ? {
          at: last.createdAt,
          action: last.action,
          result: last.result,
          detail: last.detail,
        }
      : null,
    totalCount: countRows[0]?.total ?? 0,
    errorCount: countRows[0]?.errors ?? 0,
  };
};
