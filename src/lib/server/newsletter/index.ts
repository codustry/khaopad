/**
 * Newsletter helpers (v2.0b). Everything here is **optional** —
 * the public subscribe form, the CMS subscribers page, and the
 * digest sender all work whether or not the operator has configured
 * an email provider. When no provider is configured:
 *
 *   - Public signup creates the row with `confirmedAt = NOW()`
 *     (single-opt-in mode).
 *   - The confirmation email is silently skipped.
 *   - The digest sender no-ops with a clear log line.
 *
 * The only provider we wire today is **Resend** because it has the
 * simplest auth model (one API key, no MX setup). Cloudflare Email
 * Routing requires per-domain DNS work and is harder to ship as a
 * generic default.
 *
 * To enable: paste a Resend API key + a sender address into
 * /cms/settings → "Newsletter" section.
 */
import type { Locale, SiteSettings } from "$lib/server/content/types";

/** Operator-supplied newsletter settings, all optional. */
export interface NewsletterConfig {
  /** Resend API key (`re_...`). Empty = newsletters not configured. */
  resendKey?: string;
  /** Sender address (e.g. `Site <hello@example.com>`). Required when
   *  resendKey is set; the Resend API rejects sends without a verified
   *  domain in this address. */
  senderAddress?: string;
  /** When true and resendKey is empty, public signup goes
   *  single-opt-in (subscribers immediately confirmed). When false,
   *  public signup is disabled entirely (404 on the public form). */
  allowSingleOptIn?: boolean;
}

/**
 * Pull the newsletter config out of `SiteSettings`. We store the
 * three values under settings keys (`newsletter.resendKey`,
 * `newsletter.senderAddress`, `newsletter.allowSingleOptIn`) so
 * they're managed from the same place as everything else and can
 * be migrated like any other setting.
 */
export function readNewsletterConfig(settings: SiteSettings): NewsletterConfig {
  return {
    resendKey:
      (settings["newsletter.resendKey"] as string | undefined) ?? undefined,
    senderAddress:
      (settings["newsletter.senderAddress"] as string | undefined) ?? undefined,
    allowSingleOptIn:
      (settings["newsletter.allowSingleOptIn"] as boolean | undefined) ?? true,
  };
}

/** Is real email delivery wired? */
export function isProviderConfigured(cfg: NewsletterConfig): boolean {
  return Boolean(cfg.resendKey && cfg.senderAddress);
}

/**
 * Send an email via Resend. Returns `{ ok: true }` on success or
 * `{ ok: false, reason: "..." }` otherwise. Best-effort: we never
 * throw — callers decide whether a missing send is fatal.
 *
 * When the provider isn't configured, returns `{ ok: false, reason:
 * "no provider configured" }` without making a network call.
 */
export async function sendEmail(
  cfg: NewsletterConfig,
  args: { to: string; subject: string; html: string; text?: string },
): Promise<{ ok: true; id?: string } | { ok: false; reason: string }> {
  if (!isProviderConfigured(cfg)) {
    return { ok: false, reason: "no provider configured" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.resendKey}`,
      },
      body: JSON.stringify({
        from: cfg.senderAddress,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `resend ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: data?.id };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build the confirmation email HTML/text. */
export function buildConfirmEmail(args: {
  siteName: string;
  origin: string;
  token: string;
  locale: Locale;
}): { subject: string; html: string; text: string } {
  const link = `${args.origin}/api/newsletter/confirm?token=${args.token}`;
  const subjectTh = `ยืนยันการสมัครรับข่าวสารจาก ${args.siteName}`;
  const subjectEn = `Confirm your subscription to ${args.siteName}`;
  const bodyTh = `กรุณาคลิกลิงก์นี้เพื่อยืนยันการสมัคร: ${link}\n\nหากคุณไม่ได้สมัครรับข่าวสารนี้ ก็เพิกเฉยอีเมลนี้ได้เลย`;
  const bodyEn = `Click this link to confirm your subscription: ${link}\n\nIf you didn't sign up, you can safely ignore this email.`;
  const text = args.locale === "th" ? bodyTh : bodyEn;
  const subject = args.locale === "th" ? subjectTh : subjectEn;
  const html = `<!doctype html><html><body style="font-family: -apple-system, sans-serif; line-height: 1.5; max-width: 560px; margin: 2em auto; padding: 0 1em">
    <p>${escapeHtml(text.split("\n\n")[0])}</p>
    <p><a href="${escapeAttr(link)}" style="display: inline-block; padding: 10px 18px; background: #c5f24c; color: #000; border-radius: 999px; border: 2px solid #000; text-decoration: none; font-weight: 600">${args.locale === "th" ? "ยืนยัน" : "Confirm"}</a></p>
    <p style="color: #666; font-size: 13px">${escapeHtml(text.split("\n\n")[1] ?? "")}</p>
  </body></html>`;
  return { subject, html, text };
}

/** Build a weekly digest email. */
export function buildDigestEmail(args: {
  siteName: string;
  origin: string;
  unsubscribeToken: string;
  locale: Locale;
  articles: Array<{ slug: string; title: string; excerpt: string | null }>;
}): { subject: string; html: string; text: string } {
  const unsubLink = `${args.origin}/api/newsletter/unsubscribe?token=${args.unsubscribeToken}`;
  const subjectTh = `${args.siteName}: เนื้อหาใหม่สัปดาห์นี้`;
  const subjectEn = `${args.siteName}: this week's reading`;
  const subject = args.locale === "th" ? subjectTh : subjectEn;
  const itemsHtml = args.articles
    .map((a) => {
      const link = `${args.origin}/${args.locale}/blog/${a.slug}`;
      return `<li style="margin: 0 0 1em">
        <a href="${escapeAttr(link)}" style="color: #000; text-decoration: none; font-weight: 600">${escapeHtml(a.title)}</a>
        ${a.excerpt ? `<p style="color: #555; margin: 0.25em 0 0; font-size: 14px">${escapeHtml(a.excerpt)}</p>` : ""}
      </li>`;
    })
    .join("");
  const itemsText = args.articles
    .map(
      (a) =>
        `• ${a.title}\n  ${args.origin}/${args.locale}/blog/${a.slug}${a.excerpt ? "\n  " + a.excerpt : ""}`,
    )
    .join("\n\n");
  const unsubLabel =
    args.locale === "th" ? "ยกเลิกการรับข่าวสาร" : "Unsubscribe";
  const html = `<!doctype html><html><body style="font-family: -apple-system, sans-serif; line-height: 1.5; max-width: 560px; margin: 2em auto; padding: 0 1em">
    <h2 style="margin: 0 0 1em">${escapeHtml(args.siteName)}</h2>
    <ul style="list-style: none; padding: 0; margin: 0">${itemsHtml}</ul>
    <hr style="border: none; border-top: 1px solid #ddd; margin: 2em 0" />
    <p style="color: #666; font-size: 12px">
      <a href="${escapeAttr(unsubLink)}" style="color: #666">${unsubLabel}</a>
    </p>
  </body></html>`;
  const text = `${args.siteName}\n\n${itemsText}\n\n---\n${unsubLabel}: ${unsubLink}`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
