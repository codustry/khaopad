import { error, redirect } from "@sveltejs/kit";
import { logAudit } from "$lib/server/audit";
import { localePath, DEFAULT_LOCALE } from "$lib/i18n";
import type { Locale } from "$lib/server/content/types";
import type { RequestHandler } from "./$types";

/**
 * GET /api/newsletter/unsubscribe?token=...
 *
 * One-click unsubscribe link target (v2.0b). Embedded in every
 * digest email. Stamps `unsubscribedAt = now()` on the matching
 * subscriber and 302s back to the public site.
 *
 * Idempotent: re-clicking the link is a no-op (the timestamp is set
 * once on first unsubscribe and not overwritten).
 *
 * GDPR / CAN-SPAM: clicking the link must not require any further
 * action. No CAPTCHA, no confirm-page interstitial.
 */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
  const token = url.searchParams.get("token")?.trim();
  if (!token) throw error(400, "Missing token");

  const subscriber = await locals.content.unsubscribeByToken(token);
  if (!subscriber) throw error(404, "Invalid token");

  if (platform?.env?.DB) {
    await logAudit(
      platform.env.DB,
      null,
      "newsletter.unsubscribe",
      subscriber.id,
      { email: subscriber.email },
    );
  }

  const locale = (subscriber.locale as Locale) ?? DEFAULT_LOCALE;
  throw redirect(
    302,
    `${localePath(locale, "/")}?newsletter=unsubscribed`,
  );
};
