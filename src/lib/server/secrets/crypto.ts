/**
 * Envelope encryption for admin-managed secrets.
 *
 * Secrets configured through /admin/settings/secrets are stored in D1.
 * D1 content reaches more places than a Cloudflare secret does — backups,
 * `wrangler d1 execute`, a stray `SELECT *` in a log, a future read-only
 * analytics binding. Storing a live payment key as plaintext there widens
 * the blast radius from "Cloudflare account access" to "any read of the
 * database". So values are encrypted at rest.
 *
 * ## Key derivation
 *
 * The wrapping key is derived from BETTER_AUTH_SECRET via HKDF-SHA256.
 * That secret stays a Cloudflare secret and is deliberately NOT movable
 * into the settings portal (it is consumed in `authHook` before a session
 * exists, so DB-storing it would be circular). Deriving from it means the
 * decryption key never lives in the same store as the ciphertext.
 *
 * A distinct `info` string scopes the derivation, so this key can never
 * collide with any other use of BETTER_AUTH_SECRET.
 *
 * ## Rotation
 *
 * Rotating BETTER_AUTH_SECRET makes every stored secret undecryptable.
 * That is the intended trade — it fails closed, loudly, rather than
 * silently serving a wrong key to a payment provider. Re-enter the
 * secrets through the admin UI after rotating (env vars still override,
 * so you are never locked out; see `resolve.ts`).
 */

const KEY_INFO = "khaopad:secrets:v1";
const AES_GCM_IV_BYTES = 12; // 96 bits — the value NIST specifies for GCM
const CIPHERTEXT_PREFIX = "v1:";

/**
 * Derive the AES-GCM wrapping key from BETTER_AUTH_SECRET.
 *
 * HKDF rather than using the raw secret as key material: BETTER_AUTH_SECRET
 * is an arbitrary-length, arbitrary-entropy string, and AES-GCM needs
 * exactly 256 uniformly-random bits.
 */
async function deriveKey(masterSecret: string): Promise<CryptoKey> {
  if (!masterSecret) {
    throw new Error(
      "Cannot encrypt secrets: BETTER_AUTH_SECRET is not set. " +
        "It is the key-derivation root for admin-managed secrets.",
    );
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Salt is empty by design: HKDF tolerates this (RFC 5869 §3.1) and a
      // per-row salt would have to live beside the ciphertext anyway. The
      // security here rests on BETTER_AUTH_SECRET, not on the salt.
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(KEY_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a secret for storage. Output is `v1:<base64(iv || ciphertext)>`.
 *
 * The version prefix is what makes a future re-key survivable: a `v2:`
 * reader can recognise and migrate `v1:` rows instead of guessing.
 *
 * A fresh random IV per call is mandatory for GCM — reusing an IV under
 * the same key breaks confidentiality AND authentication, not just
 * confidentiality.
 */
export async function encryptSecret(
  plaintext: string,
  masterSecret: string,
): Promise<string> {
  const key = await deriveKey(masterSecret);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return CIPHERTEXT_PREFIX + btoa(String.fromCharCode(...packed));
}

/**
 * Decrypt a stored secret. Returns null when the value cannot be
 * decrypted — wrong key (BETTER_AUTH_SECRET rotated), corrupted row, or
 * a tampered ciphertext (GCM authentication failure).
 *
 * Null rather than throw: a single unreadable secret should degrade that
 * one integration, not take down every request that touches settings.
 * Callers treat null as "not configured".
 */
export async function decryptSecret(
  stored: string,
  masterSecret: string,
): Promise<string | null> {
  if (!stored.startsWith(CIPHERTEXT_PREFIX)) return null;
  try {
    const key = await deriveKey(masterSecret);
    const raw = Uint8Array.from(
      atob(stored.slice(CIPHERTEXT_PREFIX.length)),
      (c) => c.charCodeAt(0),
    );
    if (raw.length <= AES_GCM_IV_BYTES) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, AES_GCM_IV_BYTES) },
      key,
      raw.subarray(AES_GCM_IV_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Masked form for display: last 4 characters only.
 *
 * The admin UI must NEVER round-trip a plaintext secret to the browser —
 * that would put live payment keys into page source, browser history,
 * extensions, and any proxy in the path. Fields are write-only; this is
 * the only thing the UI ever shows of an existing value.
 *
 * Short values are fully masked rather than partially revealed, since
 * revealing 4 of 6 characters is worse than revealing none.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••••••";
  return "••••••••" + plaintext.slice(-4);
}
