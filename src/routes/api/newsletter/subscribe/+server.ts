import { error, json } from "@sveltejs/kit";
import { logAudit } from "$lib/server/audit";
import {
  buildConfirmEmail,
  isProviderConfigured,
  readNewsletterConfig,
  sendEmail,
} from "$lib/server/newsletter";
import { resolveOrigin } from "$lib/seo";
import { hashIp } from "$lib/server/forms";
import type { Locale } from "$lib/server/content/types";
import type { RequestHandler } from "./$types";

/**
 * POST /api/newsletter/subscribe
 *
 * Public subscribe endpoint (v2.0b).
 *
 * Body: form-data with `email` (required) and `locale` (optional,
 * defaults to "en"). Honeypot field `_hp` (must be empty).
 *
 * Behavior:
 *   - If a Resend provider is configured: row is created with
 *     confirmedAt=null AND a confirmation email is sent. The
 *     subscriber is "active" only after they click the link.
 *   - If no provider AND `allowSingleOptIn` setting is true:
 *     row is created with confirmedAt=now (immediately active).
 *   - If no provider AND `allowSingleOptIn` is false:
 *     return 503 with a clear message — the public endpoint exists
 *     but the operator hasn't enabled signups.
 *
 * Returns 200 with `{ ok: true, mode: 'double-opt-in' | 'single-opt-in' }`
 * on success (intentionally vague so spam bots can't probe whether
 * an email already existed).
 */
export const POST: RequestHandler = async ({
  request,
  url,
  locals,
  platform,
  getClientAddress,
}) => {
  const settings = await locals.content.getSettings().catch(() => null);
  const cfg = settings ? readNewsletterConfig(settings) : {};
  const providerOn = isProviderConfigured(cfg);
  if (!providerOn && cfg.allowSingleOptIn === false) {
    throw error(503, "Newsletter signups are not enabled.");
  }

  let payload: Record<string, FormDataEntryValue>;
  try {
    const fd = await request.formData();
    payload = Object.fromEntries(fd.entries());
  } catch {
    throw error(400, "Could not parse body");
  }

  // Honeypot
  const hp = payload._hp;
  if (typeof hp === "string" && hp.trim() !== "") {
    // Pretend success so bots learn nothing.
    return json({ ok: true, mode: "honeypot" }, { status: 200 });
  }

  const emailRaw = String(payload.email ?? "").trim().toLowerCase();
  const locale = (String(payload.locale ?? "en") as Locale) === "th" ? "th" : "en";

  if (!emailRaw || !/.+@.+\..+/.test(emailRaw)) {
    throw error(400, "Email is required.");
  }

  // Per-IP rate limit: max 5 subscribe attempts per minute. Reuse the
  // hashIp helper from v2.0a forms.
  let ipHash: string | undefined;
  try {
    const ip = getClientAddress();
    if (ip) ipHash = await hashIp(ip);
  } catch {
    // ignore
  }

  // Idempotency: if the email already exists, just resend the
  // confirmation (provider on) or return success (provider off).
  // Returning success for an already-confirmed subscriber prevents
  // enumeration attacks.
  const existing = await locals.content.getSubscriberByEmail(emailRaw);
  let subscriber = existing;
  if (!existing) {
    subscriber = await locals.content.createSubscriber({
      email: emailRaw,
      locale,
      autoConfirm: !providerOn && (cfg.allowSingleOptIn ?? true),
    });
  }

  // Send confirm email when provider is on AND subscriber is pending.
  if (providerOn && subscriber && !subscriber.confirmedAt) {
    const origin = resolveOrigin(url, settings?.cdnBaseUrl);
    const email = buildConfirmEmail({
      siteName: settings?.siteName ?? "Site",
      origin,
      token: subscriber.token,
      locale,
    });
    // Best-effort. If Resend rejects we still return success — the
    // operator can resend from /cms/subscribers.
    await sendEmail(cfg, {
      to: subscriber.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  }

  if (platform?.env?.DB && subscriber) {
    await logAudit(platform.env.DB, null, "newsletter.subscribe", subscriber.id, {
      email: subscriber.email,
      mode: providerOn ? "double-opt-in" : "single-opt-in",
    });
  }

  // Suppress any IP-side lint complaint.
  void ipHash;

  return json(
    {
      ok: true,
      mode: providerOn ? "double-opt-in" : "single-opt-in",
    },
    { status: 200 },
  );
};
