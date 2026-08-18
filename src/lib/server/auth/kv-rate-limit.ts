import type { BetterAuthOptions } from "better-auth";

/**
 * KV-backed rate-limit storage for Better Auth (#182).
 *
 * Better Auth's default rate-limit storage is a module-scoped in-memory
 * `Map`. On Cloudflare Workers that map is **per-isolate**: it survives
 * across requests within one isolate but resets on eviction and is never
 * shared between isolates, so the limiter is best-effort at most — an
 * attacker spread across isolates (or patient across evictions) is barely
 * slowed, and a legitimate CGNAT-shared IP is only ever throttled inside
 * one hot isolate.
 *
 * This adapter implements Better Auth 1.6's `rateLimit.customStorage`
 * hook ({ get, set } — see BetterAuthRateLimitStorage in
 * @better-auth/core) on top of a Workers KV namespace.
 *
 * ## Why `customStorage` and not `secondaryStorage`
 *
 * Setting `secondaryStorage` on the auth options would also move SESSION
 * storage into KV (Better Auth stores sessions in secondary storage when
 * one is configured) — a much larger behavioral change than this fix
 * wants. `customStorage` affects only the rate limiter. It also lets us
 * own the TTL: the built-in "secondary-storage" wiring passes the rule's
 * window (as low as 10s) as the TTL, which Cloudflare KV would reject —
 * KV's minimum `expirationTtl` is 60 seconds.
 *
 * ## Consistency: what KV-backed limiting actually guarantees
 *
 * KV writes are eventually consistent between edge locations (typically
 * up to ~60s to propagate). That makes the limiter APPROXIMATE across
 * regions but AUTHORITATIVE within one: every isolate in a region reads
 * the same counter, so "spray requests across isolates" no longer resets
 * the count. This is a strict improvement over per-isolate memory and the
 * right trade for a rate limiter — do not reach for Durable Objects here
 * just to make a throttle strongly consistent.
 *
 * KV also coalesces rapid writes to the same key (~1 write/sec/key), so
 * bursts within a second may under-count. Again: approximate on purpose.
 *
 * ## Keying and TTL
 *
 * Better Auth keys entries as `${ip}|${path}` (IP from `x-forwarded-for`,
 * which Cloudflare sets from the real client). We add the `auth:rl:`
 * prefix so entries can never collide with CONTENT_CACHE's other tenants
 * (`q:` query cache, `gen:` generation counters, careers feed cache).
 *
 * Entries are stored with a fixed 120s TTL — comfortably above both KV's
 * 60s minimum and the longest built-in window (60s for OTP send /
 * password reset; 10s for sign-in / change-password). A stale entry that
 * outlives its window is harmless: the limiter resets `count` whenever
 * `now - lastRequest > window`, so TTL only bounds storage, never
 * correctness.
 *
 * ## Failure mode
 *
 * Fail-open. A KV read/write error must never turn into an auth 500 —
 * a broken throttle is strictly better than a broken login. Errors are
 * logged once per isolate, not per request.
 */

type RateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]
>;

/** Awaited element type of storage.get — { key, count, lastRequest }. */
type RateLimitEntry = NonNullable<Awaited<ReturnType<RateLimitStorage["get"]>>>;

/**
 * Namespaced prefix inside CONTENT_CACHE. Pinned by tests — changing it
 * risks colliding with the query cache's key space.
 */
export const AUTH_RATE_LIMIT_KEY_PREFIX = "auth:rl:";

/**
 * Fixed TTL for rate-limit entries. Must be >= 60 (KV minimum) and >= the
 * longest rate-limit window in use (60s). See module comment.
 */
export const AUTH_RATE_LIMIT_TTL_SECONDS = 120;

/** Once-per-isolate error latch — a flaky KV must not spam the logs. */
let kvErrorLogged = false;

/** Test hook: reset the once-only latch between cases. */
export function resetKvRateLimitWarnings(): void {
  kvErrorLogged = false;
}

function logKvErrorOnce(op: "get" | "put", error: unknown): void {
  if (kvErrorLogged) return;
  kvErrorLogged = true;
  console.error(
    `[auth] KV rate-limit ${op} failed — limiter degraded to fail-open for this isolate`,
    error,
  );
}

/**
 * The subset of KVNamespace this adapter needs. Structural on purpose:
 * tests supply a plain object, production supplies the real binding.
 */
export interface RateLimitKV {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/**
 * Build a Better Auth `rateLimit.customStorage` backed by Workers KV.
 */
export function createKvRateLimitStorage(kv: RateLimitKV): RateLimitStorage {
  return {
    async get(key) {
      try {
        const raw = await kv.get(AUTH_RATE_LIMIT_KEY_PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as RateLimitEntry;
        // Defensive shape check — a corrupt entry must not throttle or 500.
        if (
          typeof parsed?.count !== "number" ||
          typeof parsed?.lastRequest !== "number"
        ) {
          return null;
        }
        return parsed;
      } catch (error) {
        logKvErrorOnce("get", error);
        return null; // fail-open: no data means no throttle
      }
    },
    async set(key, value) {
      try {
        await kv.put(AUTH_RATE_LIMIT_KEY_PREFIX + key, JSON.stringify(value), {
          expirationTtl: AUTH_RATE_LIMIT_TTL_SECONDS,
        });
      } catch (error) {
        logKvErrorOnce("put", error);
        // Swallow: losing one counter update degrades the limiter, not auth.
      }
    },
  };
}
