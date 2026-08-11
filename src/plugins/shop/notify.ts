/**
 * Operator notifications (C4) — "a paid order just landed".
 *
 * The single highest-anxiety-reducing feature for a 1–5 person shop:
 * a merchant who misses a paid order for six hours loses the customer.
 * Two channels, both best-effort:
 *
 *   1. Email via the existing Resend path, to the operator address
 *      configured in site settings (`shopNotifyEmail` on
 *      /admin/settings). Unset = channel off.
 *   2. LINE Notify (POST https://notify-api.line.me/api/notify) with
 *      the token from the managed-secrets portal (`LINE_NOTIFY_TOKEN`,
 *      env-first like every other managed secret). Unset = channel off.
 *
 * Contract: NEVER throws, never fails the payment webhook. Called
 * winner-only from the Beam webhook (gated on markPaid's `justPaid`),
 * so retries never re-notify.
 */
import type { OrderWithItems } from "./order-service";
import type { ResendEnv } from "./email";
import { formatSatang, type Satang } from "./money";

export type NotifyEnv = ResendEnv & {
  LINE_NOTIFY_TOKEN?: string;
  DB?: D1Database;
};

/** env-first, then the encrypted managed_secrets table (same pattern
 *  as resolveResendKey in email.ts). */
async function resolveLineToken(env: NotifyEnv): Promise<string | undefined> {
  if (env.LINE_NOTIFY_TOKEN) return env.LINE_NOTIFY_TOKEN;
  if (!env.DB) return undefined;
  const { getSecret } = await import("$lib/server/secrets/service");
  return (
    (await getSecret(
      env as NotifyEnv & { DB: D1Database },
      "LINE_NOTIFY_TOKEN",
    )) ?? undefined
  );
}

async function resolveResendKeyForNotify(
  env: NotifyEnv,
): Promise<string | undefined> {
  if (env.RESEND_API_KEY) return env.RESEND_API_KEY;
  if (!env.DB) return undefined;
  const { getSecret } = await import("$lib/server/secrets/service");
  return (
    (await getSecret(
      env as NotifyEnv & { DB: D1Database },
      "RESEND_API_KEY",
    )) ?? undefined
  );
}

function summaryLines(order: OrderWithItems): string[] {
  return order.items.map(
    (i) =>
      `${i.quantity}× ${i.titleSnapshot}${i.skuSnapshot ? ` (${i.skuSnapshot})` : ""}`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function notifyByEmail(
  env: NotifyEnv,
  order: OrderWithItems,
  notifyEmail: string,
): Promise<boolean> {
  const apiKey = await resolveResendKeyForNotify(env);
  if (!apiKey || !env.RESEND_FROM) return false;
  const siteUrl = env.PUBLIC_SITE_URL ?? "";
  const adminUrl = `${siteUrl}/admin/shop/orders/${encodeURIComponent(order.id)}`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;">
  <h1 style="margin:0 0 8px;font-size:18px;">New paid order ${escapeHtml(order.orderNumber)}</h1>
  <p style="margin:0 0 12px;font-size:14px;color:#444;">
    ${escapeHtml(formatSatang(order.totalSatang as Satang))} · ${escapeHtml(order.email)}
  </p>
  <ul style="margin:0 0 16px;padding-left:18px;font-size:14px;">
    ${summaryLines(order)
      .map((l) => `<li>${escapeHtml(l)}</li>`)
      .join("")}
  </ul>
  <a href="${escapeHtml(adminUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">Open in admin</a>
</body></html>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [notifyEmail],
      subject: `New order ${order.orderNumber} — ${formatSatang(order.totalSatang as Satang)}`,
      html,
    }),
  });
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.notify] Resend rejected operator email for ${order.orderNumber}: ${res.status} ${await res.text()}`,
    );
    return false;
  }
  return true;
}

async function notifyByLine(
  env: NotifyEnv,
  order: OrderWithItems,
): Promise<boolean> {
  const token = await resolveLineToken(env);
  if (!token) return false;
  const message = [
    `New order ${order.orderNumber}`,
    formatSatang(order.totalSatang as Satang),
    ...summaryLines(order),
  ].join("\n");
  const res = await fetch("https://notify-api.line.me/api/notify", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ message }).toString(),
  });
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.notify] LINE Notify rejected for ${order.orderNumber}: ${res.status} ${await res.text()}`,
    );
    return false;
  }
  return true;
}

/**
 * Fire both operator channels for a freshly paid order. Each channel
 * is independently best-effort; the function itself NEVER throws.
 * Returns per-channel outcomes for tests/logging.
 */
export async function notifyNewOrder(
  env: NotifyEnv,
  order: OrderWithItems,
  opts: {
    /** Operator address from site settings (`shopNotifyEmail`). */
    notifyEmail?: string | null;
  } = {},
): Promise<{ email: boolean; line: boolean }> {
  let email = false;
  let line = false;
  const notifyEmail = opts.notifyEmail?.trim();
  if (notifyEmail) {
    try {
      email = await notifyByEmail(env, order, notifyEmail);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.notify] operator email for ${order.orderNumber} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  try {
    line = await notifyByLine(env, order);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.notify] LINE Notify for ${order.orderNumber} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
  return { email, line };
}
