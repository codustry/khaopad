/**
 * Public REST API authentication (v2.0d).
 *
 * Reads `Authorization: Bearer <key>` from the request and looks up
 * the key against the api_keys table. Returns the key's record on a
 * hit, null on miss / revoked / expired.
 *
 * The provider's `authenticateApiKey()` does the SHA-256 hash + DB
 * lookup + lastUsedAt bump. This module is just the request-parsing
 * shim plus the scope check.
 */
import type { ApiKeyRecord, ApiKeyScope, ContentProvider } from "$lib/server/content/types";

export interface AuthResult {
  ok: boolean;
  key: ApiKeyRecord | null;
  /** Reason for failure — used in error responses. */
  reason?: "missing" | "invalid" | "scope";
}

export async function authenticate(
  request: Request,
  content: ContentProvider,
): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false, key: null, reason: "missing" };
  const rawKey = match[1].trim();
  if (!rawKey) return { ok: false, key: null, reason: "missing" };
  const key = await content.authenticateApiKey(rawKey);
  if (!key) return { ok: false, key: null, reason: "invalid" };
  return { ok: true, key };
}

export function hasScope(
  key: ApiKeyRecord,
  required: ApiKeyScope,
): boolean {
  if (key.scopes.includes("*:read")) return true;
  return key.scopes.includes(required);
}
