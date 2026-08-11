/**
 * Order receipt + shipped email — transactional order mail.
 *
 * Receipt goes out when an order transitions to `paid`; the shipped
 * email (C1) when the admin marks it fulfilled, carrying the carrier
 * name and a tracking link from carriers.ts.
 *
 * Uses Resend (same provider as v2.0b newsletter). Configured via
 * env: RESEND_API_KEY + RESEND_FROM (email address). Silently no-ops
 * when unconfigured — checkout still succeeds, the customer just
 * doesn't get a receipt (they can lookup via /order/[number]).
 *
 * v3.2 ships English-only templates. v3.4 will fold in Thai + i18n
 * via Paraglide. Kept HTML minimal + inline-styled — inbox rendering
 * is fickle; CSS files don't survive most email clients.
 */
import type { OrderWithItems } from "./order-service";
import type { ShopFulfillment } from "./schema-operations";
import { carrierLabel, trackingUrl } from "./carriers";
import { formatSatang, type Satang } from "./money";

export type ResendEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  PUBLIC_SITE_URL?: string;
};

function buildReceiptHtml(order: OrderWithItems, siteUrl: string): string {
  const itemsHtml = order.items
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;">
            <div style="font-weight:600;">${escape(item.titleSnapshot)}</div>
            ${item.skuSnapshot ? `<div style="font-size:12px;color:#666;">SKU: ${escape(item.skuSnapshot)}</div>` : ""}
            <div style="font-size:12px;color:#666;">Qty ${item.quantity} × ${formatSatang(item.priceSnapshotSatang as Satang)}</div>
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums;">
            ${formatSatang(item.lineSubtotalSatang as Satang)}
          </td>
        </tr>`,
    )
    .join("");

  const lookupUrl = `${siteUrl}/order/${encodeURIComponent(order.orderNumber)}?email=${encodeURIComponent(order.email)}`;

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:#f7f7f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 4px;font-size:20px;">Thanks for your order</h1>
          <p style="margin:0;color:#666;font-size:14px;">Order ${escape(order.orderNumber)}</p>
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
            ${itemsHtml}
            <tr>
              <td style="padding:12px 0 4px;color:#666;">Subtotal</td>
              <td style="padding:12px 0 4px;text-align:right;font-variant-numeric:tabular-nums;">${formatSatang(order.subtotalSatang as Satang)}</td>
            </tr>
            ${order.shippingSatang > 0 ? `<tr><td style="color:#666;padding:2px 0;">Shipping</td><td style="text-align:right;font-variant-numeric:tabular-nums;padding:2px 0;">${formatSatang(order.shippingSatang as Satang)}</td></tr>` : ""}
            ${order.taxSatang > 0 ? `<tr><td style="color:#666;padding:2px 0;">Tax</td><td style="text-align:right;font-variant-numeric:tabular-nums;padding:2px 0;">${formatSatang(order.taxSatang as Satang)}</td></tr>` : ""}
            <tr>
              <td style="padding:12px 0 0;font-weight:600;border-top:1px solid #eee;">Total</td>
              <td style="padding:12px 0 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;border-top:1px solid #eee;">${formatSatang(order.totalSatang as Satang)}</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <a href="${escapeAttr(lookupUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">View order</a>
        </td></tr>
      </table>
      <p style="margin-top:24px;font-size:12px;color:#999;">
        You can look up your order any time at ${escape(siteUrl)}/lookup — you'll need ${escape(order.orderNumber)} + this email address.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Shipped-notification body (C1) — same idiom as the receipt. */
function buildShippedHtml(
  order: OrderWithItems,
  fulfillment: Pick<ShopFulfillment, "carrier" | "trackingNumber">,
  siteUrl: string,
): string {
  const itemsHtml = order.items
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;">
            <div style="font-weight:600;">${escape(item.titleSnapshot)}</div>
            <div style="font-size:12px;color:#666;">Qty ${item.quantity}</div>
          </td>
        </tr>`,
    )
    .join("");

  const lookupUrl = `${siteUrl}/order/${encodeURIComponent(order.orderNumber)}?email=${encodeURIComponent(order.email)}`;
  const carrier = fulfillment.carrier ? carrierLabel(fulfillment.carrier) : "";
  const trackUrl = trackingUrl(fulfillment.carrier, fulfillment.trackingNumber);
  const trackingHtml = fulfillment.trackingNumber
    ? `<p style="margin:0 0 4px;font-size:14px;">
        ${carrier ? `${escape(carrier)} — ` : ""}tracking number
        <strong style="font-variant-numeric:tabular-nums;">${escape(fulfillment.trackingNumber)}</strong>
      </p>
      ${trackUrl ? `<a href="${escapeAttr(trackUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;margin-top:8px;">Track your package</a>` : ""}`
    : carrier
      ? `<p style="margin:0;font-size:14px;">Shipped via ${escape(carrier)}.</p>`
      : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:#f7f7f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 4px;font-size:20px;">Your order is on its way</h1>
          <p style="margin:0;color:#666;font-size:14px;">Order ${escape(order.orderNumber)}</p>
        </td></tr>
        <tr><td style="padding:0 32px 16px;">
          ${trackingHtml}
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
            ${itemsHtml}
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <a href="${escapeAttr(lookupUrl)}" style="display:inline-block;color:#111;text-decoration:underline;font-size:14px;">View order</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escape(s).replace(/'/g, "&#39;");
}

/**
 * Resolve the Resend key: env first, then the encrypted secrets table.
 *
 * Falls back to `env.RESEND_API_KEY` alone when there is no DB binding,
 * so this stays usable in tests and in any context without a database.
 */
async function resolveResendKey(
  env: ResendEnv & { DB?: D1Database },
): Promise<string | undefined> {
  if (env.RESEND_API_KEY) return env.RESEND_API_KEY;
  if (!env.DB) return undefined;
  const { getSecret } = await import("$lib/server/secrets/service");
  return (
    (await getSecret(
      env as ResendEnv & { DB: D1Database },
      "RESEND_API_KEY",
    )) ?? undefined
  );
}

/**
 * Send the order receipt via Resend. Returns true on success, false
 * (with console.warn) on any failure — never throws into the caller.
 */
export async function sendOrderReceipt(
  env: ResendEnv,
  order: OrderWithItems,
): Promise<boolean> {
  // Resolves env-first, then the encrypted managed_secrets table, so the
  // key can be set from /admin/settings/secrets. Still a silent no-op when
  // unset — a missing email key must never fail a paid order.
  const apiKey = await resolveResendKey(env);
  if (!apiKey || !env.RESEND_FROM) {
    return false;
  }
  const siteUrl = env.PUBLIC_SITE_URL ?? "";
  const html = buildReceiptHtml(order, siteUrl);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [order.email],
        subject: `Your order ${order.orderNumber} — thanks for shopping`,
        html,
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.email] Resend rejected receipt for ${order.orderNumber}: ${res.status} ${await res.text()}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.email] receipt for ${order.orderNumber} failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Send the "shipped" email (C1) with carrier + tracking link. Same
 * contract as sendOrderReceipt: best-effort, silent no-op when Resend
 * isn't configured, never throws into the caller.
 */
export async function sendShippedEmail(
  env: ResendEnv,
  order: OrderWithItems,
  fulfillment: Pick<ShopFulfillment, "carrier" | "trackingNumber">,
): Promise<boolean> {
  const apiKey = await resolveResendKey(env);
  if (!apiKey || !env.RESEND_FROM) {
    return false;
  }
  const siteUrl = env.PUBLIC_SITE_URL ?? "";
  const html = buildShippedHtml(order, fulfillment, siteUrl);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [order.email],
        subject: `Your order ${order.orderNumber} has shipped`,
        html,
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.email] Resend rejected shipped email for ${order.orderNumber}: ${res.status} ${await res.text()}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.email] shipped email for ${order.orderNumber} failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
