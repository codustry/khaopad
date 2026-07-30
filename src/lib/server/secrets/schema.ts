import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Admin-managed secrets, encrypted at rest.
 *
 * Deliberately NOT reusing `site_settings`, even though it is also a
 * key/value table. Three reasons:
 *
 *  1. `site_settings` is read wholesale (`SELECT *` in the D1 provider)
 *     and its values flow into page data. Secrets must never travel that
 *     path — a single future `settings` prop on a layout would leak every
 *     payment key to the browser.
 *  2. Different value semantics: everything here is ciphertext, so a
 *     caller that forgets to decrypt gets obvious garbage rather than a
 *     plausible-looking wrong value.
 *  3. Separate tables make the audit story legible — `updated_by` is
 *     meaningful for a credential change and noise for a site title.
 */
export const managedSecrets = sqliteTable("managed_secrets", {
  /** Matches the env var name this value overrides, e.g. BEAM_API_KEY. */
  key: text("key").primaryKey(),
  /**
   * `v1:<base64(iv || ciphertext)>` — AES-GCM, key derived from
   * BETTER_AUTH_SECRET. Never a plaintext value. The `v1:` prefix exists
   * so a future re-key can recognise and migrate old rows rather than
   * guessing at the format.
   */
  valueEncrypted: text("value_encrypted").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** User id of the admin who last set it — credential changes need attribution. */
  updatedBy: text("updated_by"),
});

export type ManagedSecret = typeof managedSecrets.$inferSelect;
