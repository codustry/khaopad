import { error, redirect } from "@sveltejs/kit";
import { logAudit } from "$lib/server/audit";
import { dispatchEvent } from "$lib/server/webhooks";
import { localePath, DEFAULT_LOCALE } from "$lib/i18n";
import type { Locale } from "$lib/server/content/types";
import type { RequestHandler } from "./$types";

/**
 * GET /api/newsletter/confirm?token=...
 *
 * Click target for the confirmation email (v2.0b). Stamps
 * `confirmedAt = now()` on the matching subscriber and 302s back to
 * the public site with a small flash query parameter so the home
 * page (or whatever the operator points the redirect at) can show a
 * thank-you banner.
 *
 * Idempotent: re-clicking the same link is a no-op.
 *
 * Bad tokens 404 — we deliberately don't reveal whether the token
 * existed or not.
 */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
  const token = url.searchParams.get("token")?.trim();
  if (!token) throw error(400, "Missing token");

  const subscriber = await locals.content.confirmSubscriber(token);
  if (!subscriber) throw error(404, "Invalid token");

  if (platform?.env?.DB) {
    await logAudit(
      platform.env.DB,
      null,
      "newsletter.confirm",
      subscriber.id,
      { email: subscriber.email },
    );
  }

  // v2.0d webhook fan-out. Receivers can mirror to a CRM or trigger
  // a welcome flow. Email is included so receivers can route by
  // identity without a follow-up lookup.
  void dispatchEvent(locals.content, {
    event: "subscriber.confirm",
    payload: {
      subscriberId: subscriber.id,
      email: subscriber.email,
      locale: subscriber.locale,
      source: subscriber.source,
    },
  });

  // Redirect back to the locale home with a flash. Locale comes from
  // the subscriber record so we land them in their language.
  const locale = (subscriber.locale as Locale) ?? DEFAULT_LOCALE;
  throw redirect(
    302,
    `${localePath(locale, "/")}?newsletter=confirmed`,
  );
};
