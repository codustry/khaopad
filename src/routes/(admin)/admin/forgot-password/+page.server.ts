import { redirect } from "@sveltejs/kit";
import { createAuth } from "$lib/server/auth";
import { guardedAuthHandler } from "$lib/server/auth/rate-limit-guard";
import { claimResetIpSlot } from "$lib/server/auth/reset-throttle";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // Somebody already signed in has no business here; the profile page is
  // where a known password gets changed.
  if (locals.user) throw redirect(302, "/admin/dashboard");
  return {};
};

/**
 * The one response this action ever returns on a well-formed request.
 *
 * ## Why a single constant and not three branches
 *
 * Account enumeration is the whole risk on this endpoint. An attacker
 * POSTs addresses and reads the reply; ANY observable difference between
 * "no such account", "sent", and "already sent today" turns the reset
 * form into a membership oracle for the admin panel — a list of exactly
 * which addresses are worth phishing or credential-stuffing.
 *
 * So all three collapse to this object. Making it a shared constant
 * rather than three identical literals is deliberate: it means a future
 * edit cannot make one branch drift (a stray `error:`, a different
 * message) without deleting the constant and noticing why it existed.
 *
 * The throttle decision is invisible for the same reason — see
 * `sendResetPassword` in $lib/server/auth: it returns silently when the
 * 24h window is open, so a throttled request is indistinguishable from a
 * delivered one. If the rate limit answered differently, an attacker
 * could learn "this address HAS an account and someone reset it today",
 * which is worse than the plain existence leak.
 */
const OPAQUE_RESULT = { sent: true } as const;

export const actions: Actions = {
  default: async ({ request, platform }) => {
    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim();

    // A malformed/empty submission is the ONE case that may answer
    // differently: it leaks nothing about any account, and silently
    // "succeeding" on an empty box is a usability trap.
    if (!email || !email.includes("@")) {
      return { sent: false, invalid: true };
    }

    // No platform (bare `vite dev` without bindings) — answer the opaque
    // success rather than a 503 that would itself be a signal, and would
    // differ from production behaviour for a prober.
    if (!platform?.env?.DB) return OPAQUE_RESULT;

    // Defence in depth beside the per-account 24h limit: one origin may
    // trigger mail for a bounded number of DIFFERENT accounts per day, so
    // walking a list of addresses costs an attacker more than it costs
    // us. Failure is silent for the same enumeration reason.
    const clientIp =
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const ipAllowed = await claimResetIpSlot(platform.env.DB, clientIp);
    if (!ipAllowed) return OPAQUE_RESULT;

    const auth = createAuth(platform.env.DB, {
      BETTER_AUTH_SECRET: platform.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: platform.env.BETTER_AUTH_URL,
      RESEND_API_KEY: platform.env.RESEND_API_KEY,
      RESEND_FROM: platform.env.RESEND_FROM,
      CONTENT_CACHE: platform.env.CONTENT_CACHE,
    });

    // Routed through auth.handler + guardedAuthHandler rather than
    // auth.api.forgetPassword — same reasoning the profile action
    // records: Better Auth's rate limiter lives in its router's
    // onRequest hook, so a direct api call would skip BOTH that limiter
    // and the Cloudflare binding guard, leaving this the one unthrottled
    // way to make the Worker send mail. Headers are forwarded wholesale
    // because the CSRF check needs Origin and the limiter keys on the
    // client IP headers.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.set("content-type", "application/json");
    fwdHeaders.delete("content-length");

    try {
      await guardedAuthHandler(
        auth,
        // `/request-password-reset` is the endpoint Better Auth 1.6.5
        // actually registers (api/routes/password.mjs). `/forget-password`
        // is NOT a route in this version — it survives only in the
        // library's own rate-limiter path list, which is why the stale
        // name looked plausible. Posting to it returns 404, and because
        // this action swallows failures for enumeration reasons, that
        // 404 would have been completely silent: the form would report
        // success and no mail would ever be sent. Verified live.
        new Request(new URL("/api/auth/request-password-reset", request.url), {
          method: "POST",
          headers: fwdHeaders,
          body: JSON.stringify({
            email,
            redirectTo: "/admin/reset-password",
          }),
        }),
        platform.env.AUTH_RATE_LIMITER,
      );
    } catch {
      // Swallow deliberately. A send failure, a 429, or a Resend outage
      // must all look like the success case — an error surfaced here
      // would re-open the enumeration channel this action exists to
      // close. Operators see the cause in the Worker logs.
    }

    return OPAQUE_RESULT;
  },
};
