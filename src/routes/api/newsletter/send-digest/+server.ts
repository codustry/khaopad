import { error, json } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import {
  buildDigestEmail,
  isProviderConfigured,
  readNewsletterConfig,
  sendEmail,
} from "$lib/server/newsletter";
import { resolveOrigin } from "$lib/seo";
import { SUPPORTED_LOCALES } from "$lib/i18n";
import type { Locale } from "$lib/server/content/types";
import type { RequestHandler } from "./$types";

/**
 * POST /api/newsletter/send-digest
 *
 * Admin-only digest send (v2.0b). Iterates all active subscribers
 * (confirmedAt non-null AND unsubscribedAt null), groups by locale,
 * pulls the last `?days=7` published articles per locale, and sends
 * one email per subscriber.
 *
 * Body params (optional, all via query):
 *   - days=7       — window of articles to include
 *   - dryRun=1     — count subscribers without sending
 *
 * Returns `{ ok, sent, failed, dryRun }`.
 *
 * **Optional**: when no provider is configured, returns 503 with a
 * clear message instead of attempting to send.
 *
 * Future: a Cloudflare Worker cron-trigger can hit this endpoint
 * weekly with a wrangler-secret bearer token. Not wired in this PR
 * because the cron config belongs to the operator's wrangler.toml.
 */
export const POST: RequestHandler = async ({
  url,
  locals,
  platform,
}) => {
  if (!locals.user) throw error(401, "Not authenticated");
  if (!hasRole(locals.user, "admin")) throw error(403, "Forbidden");

  const settings = await locals.content.getSettings().catch(() => null);
  const cfg = settings ? readNewsletterConfig(settings) : {};
  if (!isProviderConfigured(cfg)) {
    throw error(
      503,
      "No email provider configured. Add a Resend API key + sender address in /cms/settings.",
    );
  }

  const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") ?? "7")));
  const dryRun = url.searchParams.get("dryRun") === "1";

  const subscribers = await locals.content.listSubscribers({
    onlyActive: true,
  });

  const origin = resolveOrigin(url, settings?.cdnBaseUrl);

  // Pre-fetch articles per locale once. Cheap.
  const articlesByLocale = new Map<
    Locale,
    Array<{ slug: string; title: string; excerpt: string | null }>
  >();
  for (const locale of SUPPORTED_LOCALES) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await locals.content.listArticles({
      status: "published",
      onlyPublished: true,
      locale,
      page: 1,
      limit: 10,
    });
    const recent = result.items.filter(
      (a) => (a.publishedAt ?? a.createdAt) >= cutoff,
    );
    articlesByLocale.set(
      locale,
      recent
        .map((a) => {
          const loc = a.localizations[locale] ?? a.localizations.en;
          if (!loc) return null;
          return { slug: a.slug, title: loc.title, excerpt: loc.excerpt };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .slice(0, 5),
    );
  }

  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      subscribers: subscribers.length,
      articleCounts: Object.fromEntries(
        Array.from(articlesByLocale.entries()).map(([l, a]) => [l, a.length]),
      ),
    });
  }

  let sent = 0;
  let failed = 0;
  for (const sub of subscribers) {
    const articles = articlesByLocale.get(sub.locale) ?? [];
    if (articles.length === 0) continue; // skip empty locales
    const email = buildDigestEmail({
      siteName: settings?.siteName ?? "Site",
      origin,
      unsubscribeToken: sub.token,
      locale: sub.locale,
      articles,
    });
    const result = await sendEmail(cfg, {
      to: sub.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (result.ok) {
      sent++;
      if (platform?.env?.DB) {
        await logAudit(
          platform.env.DB,
          locals.user.id,
          "newsletter.digest_sent",
          sub.id,
          { email: sub.email, articleCount: articles.length },
        );
      }
    } else {
      failed++;
    }
  }

  return json({ ok: true, sent, failed, days });
};
