/**
 * Read/write admin-managed secrets.
 *
 * ## Precedence: env ALWAYS wins over the database
 *
 * This is deliberate and load-bearing in three situations:
 *
 *  - **Rotation under compromise.** If a key leaks you can push a new one
 *    with `wrangler secret put` and it takes effect immediately, without
 *    needing a working admin panel (which may be exactly what is
 *    compromised).
 *  - **Existing deployments.** Sites already configured via env keep
 *    working untouched after this feature ships. Nothing to migrate.
 *  - **Environment separation.** A staging Worker can override production
 *    values inherited from a shared database.
 *
 * The cost is that a value set in env cannot be changed from the UI. The
 * settings page states this explicitly rather than silently ignoring input.
 */

import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import { managedSecrets } from "./schema";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";
import { isManagedSecret, MANAGED_SECRETS } from "./registry";

export type SecretStatus = {
  key: string;
  /** Whether a usable value exists from any source. */
  configured: boolean;
  /** Where the effective value comes from. */
  source: "env" | "database" | "unset";
  /**
   * Masked (or full, for non-sensitive) preview of the effective value.
   * Never the plaintext of a sensitive secret.
   */
  preview: string | null;
  /** True when a stored row exists but could not be decrypted. */
  undecryptable: boolean;
  updatedAt: string | null;
};

type EnvLike = Record<string, unknown> & { DB: D1Database };

function envValue(env: EnvLike, key: string): string | undefined {
  const raw = env[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Resolve one secret's effective value: env first, then the encrypted row.
 *
 * Returns null when unset or undecryptable — callers treat both as "not
 * configured", which is what makes an unreadable row degrade one
 * integration instead of throwing on every request.
 */
export async function getSecret(
  env: EnvLike,
  key: string,
): Promise<string | null> {
  const fromEnv = envValue(env, key);
  if (fromEnv) return fromEnv;

  const masterSecret = envValue(env, "BETTER_AUTH_SECRET");
  if (!masterSecret) return null;

  const row = await drizzle(env.DB)
    .select()
    .from(managedSecrets)
    .where(eq(managedSecrets.key, key))
    .limit(1)
    .get();
  if (!row) return null;

  return decryptSecret(row.valueEncrypted, masterSecret);
}

/**
 * Resolve several secrets in one query.
 *
 * Used on the request path (plugin init) where a query per secret would
 * add avoidable round-trips to every cold start.
 */
export async function getSecrets(
  env: EnvLike,
  keys: readonly string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const needed: string[] = [];

  for (const key of keys) {
    const fromEnv = envValue(env, key);
    if (fromEnv) result[key] = fromEnv;
    else {
      result[key] = null;
      needed.push(key);
    }
  }
  if (needed.length === 0) return result;

  const masterSecret = envValue(env, "BETTER_AUTH_SECRET");
  if (!masterSecret) return result;

  const rows = await drizzle(env.DB)
    .select()
    .from(managedSecrets)
    .where(inArray(managedSecrets.key, needed))
    .all();

  for (const row of rows) {
    result[row.key] = await decryptSecret(row.valueEncrypted, masterSecret);
  }
  return result;
}

/**
 * Status of every managed secret, for the admin page.
 *
 * Returns previews only — never a plaintext sensitive value. The admin
 * form is write-only by design: round-tripping a live payment key to the
 * browser would put it in page source, browser history, extensions, and
 * any intermediary proxy.
 */
export async function listSecretStatus(env: EnvLike): Promise<SecretStatus[]> {
  const masterSecret = envValue(env, "BETTER_AUTH_SECRET");
  const rows = await drizzle(env.DB).select().from(managedSecrets).all();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const out: SecretStatus[] = [];
  for (const def of MANAGED_SECRETS) {
    const fromEnv = envValue(env, def.key);
    if (fromEnv) {
      out.push({
        key: def.key,
        configured: true,
        source: "env",
        preview: def.sensitive ? maskSecret(fromEnv) : fromEnv,
        undecryptable: false,
        updatedAt: null,
      });
      continue;
    }

    const row = byKey.get(def.key);
    if (!row) {
      out.push({
        key: def.key,
        configured: false,
        source: "unset",
        preview: null,
        undecryptable: false,
        updatedAt: null,
      });
      continue;
    }

    const plaintext = masterSecret
      ? await decryptSecret(row.valueEncrypted, masterSecret)
      : null;
    out.push({
      key: def.key,
      configured: plaintext !== null,
      source: plaintext !== null ? "database" : "unset",
      preview:
        plaintext === null
          ? null
          : def.sensitive
            ? maskSecret(plaintext)
            : plaintext,
      // A row exists but did not decrypt — almost always a rotated
      // BETTER_AUTH_SECRET. Surfaced so the admin sees a real explanation
      // instead of a silently "unset" field they know they configured.
      undecryptable: plaintext === null,
      updatedAt: row.updatedAt,
    });
  }
  return out;
}

/**
 * Store (or replace) a secret. Encrypts before it touches the database.
 *
 * Rejects unknown keys: without that check a crafted POST could write an
 * arbitrary key, including one shadowing an env var the registry
 * deliberately refuses to manage.
 */
export async function setSecret(
  env: EnvLike,
  key: string,
  plaintext: string,
  updatedBy: string,
): Promise<void> {
  if (!isManagedSecret(key)) {
    throw new Error(`Refusing to store unmanaged secret key: ${key}`);
  }
  const masterSecret = envValue(env, "BETTER_AUTH_SECRET");
  if (!masterSecret) {
    throw new Error(
      "Cannot store secrets: BETTER_AUTH_SECRET is not set on this Worker.",
    );
  }
  const valueEncrypted = await encryptSecret(plaintext, masterSecret);
  const nowIso = new Date().toISOString();

  // Raw SQL rather than drizzle's `.onConflictDoUpdate()`: D1 does not
  // expose conflict-clause builders uniformly across drizzle versions on
  // the sqlite dialect. `discount-service.ts` hit exactly this and uses
  // raw SQL for the same reason. An upsert that silently degrades to a
  // failed INSERT here would leave a rotated credential unsaved while the
  // UI reported success.
  await env.DB.prepare(
    `INSERT INTO managed_secrets (key, value_encrypted, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET
       value_encrypted = excluded.value_encrypted,
       updated_at      = excluded.updated_at,
       updated_by      = excluded.updated_by`,
  )
    .bind(key, valueEncrypted, nowIso, updatedBy)
    .run();
}

/** Remove a stored secret. Any env value keeps applying afterwards. */
export async function deleteSecret(env: EnvLike, key: string): Promise<void> {
  if (!isManagedSecret(key)) {
    throw new Error(`Refusing to delete unmanaged secret key: ${key}`);
  }
  await drizzle(env.DB)
    .delete(managedSecrets)
    .where(eq(managedSecrets.key, key));
}
