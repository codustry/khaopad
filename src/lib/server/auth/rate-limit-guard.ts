/**
 * Credential-endpoint rate limiting via Cloudflare's Workers rate-limiting
 * binding (#182, second attempt).
 *
 * WHY THE KV APPROACH WAS NOT ENOUGH
 *
 * The first fix backed Better Auth's limiter with KV. It verified perfectly
 * against local miniflare — and did nothing at all on the deployed Worker:
 * eight spaced wrong-password attempts, zero 429s. Production KV caches
 * reads for AT LEAST 60 seconds, so a counter with Better Auth's 10-second
 * windows can never accumulate — every read within the window sees a stale
 * count. Miniflare's KV is strongly consistent, which is exactly why local
 * verification lied. The KV storage stays as defense-in-depth for the
 * 60s-window rules, but it cannot be the primary control.
 *
 * Cloudflare's `ratelimit` binding is the purpose-built primitive: per-colo,
 * in-memory, millisecond counters, with supported periods (10s / 60s) that
 * happen to match Better Auth's windows exactly. Per-colo scope is the right
 * trade — a brute-force burst arrives through one colo, and a distributed
 * attacker crossing colos is throttled per colo, which still bounds the
 * global guess rate at limit × colos rather than limit × isolates × ∞.
 *
 * WHY A WRAPPER AND NOT BETTER AUTH CONFIG
 *
 * The binding counts and answers; it is not a get/set store, so it cannot
 * back Better Auth's `customStorage`. Instead this wraps auth.handler —
 * and BOTH call sites go through it: the /api/auth catch-all route AND the
 * profile action's internal handler call (which never touches the route, so
 * a route-level guard would silently miss it — the exact H1 mistake again).
 */
import type { createAuth } from "$lib/server/auth";

/**
 * Paths that take a credential guess. Everything else (session reads, OTP
 * verification of an already-sent code, sign-out) passes straight through —
 * over-throttling those locks legitimate users out for no security gain.
 */
const GUARDED_PATHS = [
  "/sign-in/email",
  "/change-password",
  "/sign-up/email",
  "/email-otp/send-verification-otp",
  "/forget-password",
];

/** Minimal shape of the Cloudflare ratelimit binding. */
export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

/** Client IP for keying — same header precedence Better Auth uses. */
function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function guardedPath(pathname: string): string | null {
  for (const p of GUARDED_PATHS) {
    if (pathname.endsWith(p)) return p;
  }
  return null;
}

/**
 * Run auth.handler behind the rate-limit binding.
 *
 * Degrades gracefully: no binding (local vite dev, tests, a fork that has
 * not added it) or a binding error means the request proceeds — Better
 * Auth's own KV-backed limiter is still underneath, and auth must never
 * 500 because throttling infrastructure hiccuped. Fail-open here is
 * deliberate and documented rather than accidental.
 */
export async function guardedAuthHandler(
  auth: ReturnType<typeof createAuth>,
  request: Request,
  limiter: RateLimitBinding | undefined,
): Promise<Response> {
  const path = guardedPath(new URL(request.url).pathname);
  if (path && limiter) {
    try {
      const { success } = await limiter.limit({
        key: `${clientIp(request)}|${path}`,
      });
      if (!success) {
        return new Response(
          JSON.stringify({
            message: "Too many attempts. Wait a moment and try again.",
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
    } catch {
      // Binding hiccup — proceed; the KV-backed limiter still applies.
    }
  }
  return auth.handler(request);
}
