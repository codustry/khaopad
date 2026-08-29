/**
 * Durable 24-hour throttle for password-reset email (one per account per day).
 *
 * ## Why this exists
 *
 * Reset mail is the one auth path an unauthenticated stranger can make the
 * Worker send, to an address they choose, at request speed. Every fork
 * shares one Resend quota, so an unthrottled endpoint is both a spam
 * cannon pointed at a real inbox and a way to burn the whole fleet's send
 * allowance. Better Auth's built-in limiter caps the ENDPOINT at 3/60s per
 * IP; it says nothing about how many mails one mailbox receives per day.
 *
 * ## Why D1 and not KV, and not memory
 *
 * Settled by prior art in this repo, not preference:
 *
 *  - **Memory** is per-isolate on Workers. `./kv-rate-limit.ts` documents
 *    it: the default Map "resets on eviction and is never shared between
 *    isolates". Useless for a 24h window.
 *  - **KV** looks right and fails in production. `./rate-limit-guard.ts`
 *    records the live result: a KV-backed limiter "verified perfectly
 *    against local miniflare — and did nothing at all on the deployed
 *    Worker", because production KV caches reads for AT LEAST 60 seconds.
 *    A 24h window survives that read cache better than a 10s one, but KV
 *    also coalesces writes to one key (~1/sec) and is eventually
 *    consistent BETWEEN edge locations — so two requests hitting two
 *    colos inside the propagation window both read "no prior send" and
 *    both send. That is precisely the burst this limit must stop.
 *  - **The Cloudflare `ratelimit` binding** is per-colo and its supported
 *    periods are 10s / 60s — it cannot express 24 hours at all.
 *
 * D1 is the only store here that is strongly consistent, durable across
 * isolates and colos, and free-form on window length. The cost is a write
 * on the send path, which is irrelevant next to an outbound HTTP call to
 * Resend.
 *
 * ## Why the atomic INSERT is the control
 *
 * The check is not read-then-write. `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE <expired>` decides in ONE statement, so two concurrent requests
 * for the same address cannot both observe "no recent send" and both
 * proceed — the loser's `changes()` comes back 0. A read-then-write pair
 * would be a textbook TOCTOU race, and the whole point of choosing D1 was
 * to get an atomicity guarantee KV cannot give.
 *
 * ## Privacy: the key is a hash, never the address
 *
 * Rows are keyed by a SHA-256 of the lowercased email, not the address.
 * This table would otherwise become a plaintext list of "people who forgot
 * their password", readable by anything with database access, for accounts
 * that may not even exist on this deployment. The hash is enough to
 * count against, which is all the limiter needs.
 */

/** One send per address per 24 hours. */
export const RESET_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Per-IP cap, defence in depth. Enumerating addresses is cheap when each
 * one gets its own 24h budget, so a single origin is additionally capped
 * on how many DIFFERENT accounts it may trigger mail for per day.
 */
export const RESET_IP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RESET_IP_MAX_SENDS = 10;

/**
 * SHA-256 hex via WebCrypto — the Workers-native path. `node:crypto` is
 * not available in the Workers runtime; the rest of this repo hashes the
 * same way (see $lib/server/forms, $lib/server/secrets/crypto).
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Minimal D1 surface this module needs — tests supply a fake. */
export interface ThrottleD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

/**
 * Stable, non-reversible key for one email address.
 *
 * Lowercased first: mail addresses are case-insensitive in practice, and
 * `Admin@x.com` must not buy a second daily budget over `admin@x.com`.
 */
export async function emailThrottleKey(email: string): Promise<string> {
  return "email:" + (await sha256Hex(email.trim().toLowerCase()));
}

/** Key for the per-IP counter. Hashed for the same reason as the address. */
export async function ipThrottleKey(ip: string): Promise<string> {
  return "ip:" + (await sha256Hex(ip.trim()));
}

/**
 * Claim one send slot for `key`, or report that the window is still open.
 *
 * Returns true when the caller MAY send. The claim is recorded as part of
 * the same statement that decides, so the decision is race-free.
 *
 * Fails OPEN on a database error — deliberately. A locked-out admin with a
 * flaky D1 should still be able to recover their account; the downside is
 * a duplicate email, which is strictly less bad than a permanently
 * unrecoverable account. The built-in per-IP limiter still applies.
 */
export async function claimResetSlot(
  db: ThrottleD1,
  key: string,
  now: number = Date.now(),
  windowMs: number = RESET_EMAIL_WINDOW_MS,
): Promise<boolean> {
  const cutoff = now - windowMs;
  try {
    // One statement decides AND records. `changes()` is 1 only when the
    // row was inserted fresh or its previous send is older than the
    // window; the DO UPDATE's WHERE makes a still-throttled conflict a
    // no-op, which D1 reports as 0 changes.
    const result = await db
      .prepare(
        `INSERT INTO auth_reset_throttle (key, last_sent_at, send_count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           last_sent_at = ?2,
           send_count = send_count + 1
         WHERE auth_reset_throttle.last_sent_at <= ?3`,
      )
      .bind(key, now, cutoff)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth.reset] throttle check failed — failing open:",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

/**
 * Claim a slot against the per-IP daily budget.
 *
 * Distinct from the per-address claim: this one allows RESET_IP_MAX_SENDS
 * within the window rather than one, so a shared office NAT or a CGNAT
 * range does not lock out everybody behind it after a single reset.
 */
export async function claimResetIpSlot(
  db: ThrottleD1,
  ip: string,
  now: number = Date.now(),
  windowMs: number = RESET_IP_WINDOW_MS,
  maxSends: number = RESET_IP_MAX_SENDS,
): Promise<boolean> {
  const cutoff = now - windowMs;
  try {
    const result = await db
      .prepare(
        `INSERT INTO auth_reset_throttle (key, last_sent_at, send_count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           last_sent_at = ?2,
           -- Reset the counter when the previous burst aged out of the
           -- window, otherwise keep accumulating within it.
           send_count = CASE
             WHEN auth_reset_throttle.last_sent_at <= ?3 THEN 1
             ELSE auth_reset_throttle.send_count + 1
           END
         WHERE auth_reset_throttle.last_sent_at <= ?3
            OR auth_reset_throttle.send_count < ?4`,
      )
      .bind(await ipThrottleKey(ip), now, cutoff, maxSends)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth.reset] IP throttle check failed — failing open:",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}
