/**
 * Admin password-reset email.
 *
 * Same Resend idiom as ./otp-email.ts: env-first key resolution with the
 * encrypted managed_secrets table as fallback, best-effort send that never
 * throws into the caller, silent no-op when Resend is unconfigured.
 * Bilingual (EN + TH) body — the reset request carries no locale (it is
 * made from a logged-OUT page, so there is no user preference to read),
 * and the recipient may not be the person who set the site's language.
 */

export type ResetEmailEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  DB?: D1Database;
};

/**
 * Fallback sender identity for forks that have not set their own.
 *
 * ## Precedence: the deployment's own RESEND_FROM ALWAYS wins
 *
 * Every fork runs on its own domain with its own verified Resend sender
 * (bactrack → no-reply@bactrack.in.th, drvakuum → no-reply@drvakuum.com,
 * …). Those deployments set `RESEND_FROM` and this constant is never
 * consulted. It exists only so a fresh engine deployment that has an API
 * key but has not yet chosen a From address still sends a working reset
 * mail instead of silently doing nothing.
 *
 * Note the practical constraint: Resend only accepts a From address on a
 * domain verified in THAT account. A fork using its own Resend account
 * must set `RESEND_FROM` — this default will be rejected there, which is
 * the correct, loud failure rather than mail from the wrong brand.
 */
export const DEFAULT_RESET_FROM =
  "Khao Pad (ข้าวผัด) by Codustry <no-reply@codustry.com>";

/**
 * Resolve the From header: deployment value first, Codustry fallback.
 *
 * Pure and synchronous so the precedence itself stays trivially testable;
 * `resolveResetFromAsync` layers the settings-portal lookup on top.
 */
export function resolveResetFrom(env: { RESEND_FROM?: string }): string {
  const configured = env.RESEND_FROM?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_RESET_FROM;
}

/**
 * Full precedence, in order:
 *
 *   1. `RESEND_FROM` in the deployment env (wrangler secret / vars)
 *   2. `RESEND_FROM` in the encrypted settings portal
 *   3. the Codustry identity
 *
 * Step 2 exists because RESEND_FROM is a managed secret, so an operator
 * who sets it in the admin UI expects it to be used. Env still wins — the
 * same rule the secrets service documents for every other key.
 */
async function resolveResetFromAsync(env: ResetEmailEnv): Promise<string> {
  const fromEnv = env.RESEND_FROM?.trim();
  if (fromEnv) return fromEnv;
  if (env.DB) {
    try {
      const { getSecret } = await import("$lib/server/secrets/service");
      const stored = (
        await getSecret(
          env as ResetEmailEnv & { DB: D1Database },
          "RESEND_FROM",
        )
      )?.trim();
      if (stored) return stored;
    } catch {
      // A secrets-table hiccup must not block the reset mail; fall back.
    }
  }
  return DEFAULT_RESET_FROM;
}

async function resolveResendKey(
  env: ResetEmailEnv,
): Promise<string | undefined> {
  if (env.RESEND_API_KEY) return env.RESEND_API_KEY;
  if (!env.DB) return undefined;
  const { getSecret } = await import("$lib/server/secrets/service");
  return (
    (await getSecret(
      env as ResetEmailEnv & { DB: D1Database },
      "RESEND_API_KEY",
    )) ?? undefined
  );
}

/** Minimal HTML-attribute escape for the URL we interpolate into href. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildResetHtml(url: string): string {
  const safe = escapeAttr(url);
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:#f7f7f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 4px;font-size:18px;">Reset your password</h1>
          <p style="margin:0;color:#666;font-size:14px;">ตั้งรหัสผ่านใหม่</p>
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <p style="margin:0 0 16px;color:#333;font-size:14px;">
            Click the button below to choose a new password.<br/>
            คลิกปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่
          </p>
          <a href="${safe}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">Reset password / ตั้งรหัสผ่านใหม่</a>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <p style="margin:0;color:#666;font-size:13px;">
            This link expires in 1 hour and can be used only once. If you didn't request it, you can ignore this email — your password stays unchanged.<br/>
            ลิงก์นี้จะหมดอายุใน 1 ชั่วโมง และใช้ได้เพียงครั้งเดียว หากคุณไม่ได้ขอ กรุณาเพิกเฉยต่ออีเมลนี้ รหัสผ่านของคุณจะไม่เปลี่ยนแปลง
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send the password-reset link via Resend. Returns true on success, false
 * on any failure — never throws into Better Auth's endpoint.
 *
 * Unlike the OTP sender this does NOT require RESEND_FROM to be set: a
 * missing value falls back to the Codustry identity (see
 * DEFAULT_RESET_FROM). Only a missing API key disables the send.
 */
export async function sendResetPasswordEmail(
  env: ResetEmailEnv,
  input: { email: string; url: string },
): Promise<boolean> {
  const apiKey = await resolveResendKey(env);
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: await resolveResetFromAsync(env),
        to: [input.email],
        subject: "Reset your password / ตั้งรหัสผ่านใหม่",
        html: buildResetHtml(input.url),
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[auth.reset] Resend rejected reset email: ${res.status} ${await res.text()}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth.reset] Reset email failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
