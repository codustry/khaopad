/**
 * Sign-in OTP email (v3.17 D1) — customer passwordless login.
 *
 * Same Resend idiom as $plugins/shop/email.ts: env-first key resolution
 * with the encrypted managed_secrets table as fallback, best-effort
 * send that never throws into the caller, silent no-op when Resend is
 * unconfigured. Bilingual (EN + TH) body — the OTP request carries no
 * locale, and a six-digit code survives any language anyway.
 */

export type OtpEmailEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  DB?: D1Database;
};

async function resolveResendKey(env: OtpEmailEnv): Promise<string | undefined> {
  if (env.RESEND_API_KEY) return env.RESEND_API_KEY;
  if (!env.DB) return undefined;
  const { getSecret } = await import("$lib/server/secrets/service");
  return (
    (await getSecret(
      env as OtpEmailEnv & { DB: D1Database },
      "RESEND_API_KEY",
    )) ?? undefined
  );
}

function buildOtpHtml(otp: string): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:#f7f7f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 4px;font-size:18px;">Your sign-in code</h1>
          <p style="margin:0;color:#666;font-size:14px;">รหัสเข้าสู่ระบบของคุณ</p>
        </td></tr>
        <tr><td style="padding:0 32px 8px;">
          <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:6px;font-variant-numeric:tabular-nums;">${otp}</p>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <p style="margin:0;color:#666;font-size:13px;">
            This code expires in 5 minutes. If you didn't request it, you can ignore this email.<br/>
            รหัสนี้จะหมดอายุใน 5 นาที หากคุณไม่ได้ขอรหัส กรุณาเพิกเฉยต่ออีเมลนี้
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send the sign-in OTP via Resend. Returns true on success, false on
 * any failure — never throws into Better Auth's endpoint.
 */
export async function sendSignInOtpEmail(
  env: OtpEmailEnv,
  input: { email: string; otp: string },
): Promise<boolean> {
  const apiKey = await resolveResendKey(env);
  if (!apiKey || !env.RESEND_FROM) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [input.email],
        subject: `${input.otp} is your sign-in code / รหัสเข้าสู่ระบบ`,
        html: buildOtpHtml(input.otp),
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[auth.otp] Resend rejected OTP email: ${res.status} ${await res.text()}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth.otp] OTP email failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
