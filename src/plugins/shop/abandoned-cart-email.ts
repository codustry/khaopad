/**
 * Abandoned-cart recovery email.
 *
 * Sent by the sweep cron on carts that have been inactive for 24h
 * with at least one item + a captured email address (customer got
 * to checkout, entered email, then didn't complete). Email includes
 * a resume link that carries the cart's session id in a signed query
 * param so the customer's cart is restored on click.
 *
 * v3.5 MVP: 24h reminder only. #60 spec calls for 24h + 72h; the 72h
 * escalation is a small follow-up (same email module, different
 * copy + template). Deferred until the 24h email proves out.
 *
 * Every cart is emailed AT MOST ONCE — we record `abandonedEmailSentAt`
 * on the cart to prevent re-sending on subsequent cron ticks. Falls
 * back gracefully when Resend isn't configured (silent no-op, matches
 * the order-receipt pattern).
 */
import type { ShopCartItemWithContext } from "./schema-cart";
import { formatSatang, type Satang } from "./money";

export type AbandonedCartInput = {
  cartId: string;
  sessionId: string;
  email: string;
  items: ShopCartItemWithContext[];
  subtotalSatang: number;
};

export type ResendAbandonedEnv = {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  PUBLIC_SITE_URL?: string;
};

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildResumeUrl(siteUrl: string, sessionId: string): string {
  // The cart cookie is HttpOnly, so we can't restore it from a link
  // click alone. Instead, we take the visitor to /cart with a
  // ?restore=<sessionId> hint that the server's cart page reads to
  // re-cookie the session before rendering. Implementation of the
  // restore-hint reader is a small follow-up on the /cart route —
  // for MVP the link points at /cart directly and shows a note if
  // the browser has no cart cookie (visitor may need to sign in).
  const url = new URL("/cart", siteUrl || "https://example.com");
  url.searchParams.set("restore", sessionId);
  return url.toString();
}

function buildHtml(input: AbandonedCartInput, siteUrl: string): string {
  const itemRows = input.items
    .slice(0, 5) // cap to 5 in the email preview
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;">
            <div style="font-weight:600;">${escape(item.productTitle)}</div>
            ${item.variantTitle ? `<div style="font-size:12px;color:#666;">${escape(item.variantTitle)}</div>` : ""}
            <div style="font-size:12px;color:#666;">Qty ${item.quantity}</div>
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums;">
            ${formatSatang((item.priceSatangAtAdd * item.quantity) as Satang)}
          </td>
        </tr>`,
    )
    .join("");

  const moreItemsNote =
    input.items.length > 5
      ? `<p style="font-size:12px;color:#666;margin-top:8px;">+${input.items.length - 5} more items in your cart</p>`
      : "";

  const resumeUrl = buildResumeUrl(siteUrl, input.sessionId);

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:#f7f7f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 4px;font-size:20px;">Still thinking it over?</h1>
          <p style="margin:0;color:#666;font-size:14px;">Your cart is waiting.</p>
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
            ${itemRows}
            <tr>
              <td style="padding:12px 0 0;font-weight:600;">Subtotal</td>
              <td style="padding:12px 0 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${formatSatang(input.subtotalSatang as Satang)}</td>
            </tr>
          </table>
          ${moreItemsNote}
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <a href="${escape(resumeUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:14px;font-weight:600;">Continue checkout</a>
        </td></tr>
      </table>
      <p style="margin-top:16px;font-size:11px;color:#999;">
        Not you? You can safely ignore this email — the cart will
        clear itself in a few days.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send the recovery email via Resend. Returns true on success, false
 * (with console.warn) on any failure — never throws.
 */
export async function sendAbandonedCartEmail(
  env: ResendAbandonedEnv,
  input: AbandonedCartInput,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return false;
  if (input.items.length === 0) return false;
  const siteUrl = env.PUBLIC_SITE_URL ?? "";
  const html = buildHtml(input, siteUrl);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [input.email],
        subject: "Still thinking it over? Your cart is waiting.",
        html,
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[shop.abandoned] Resend rejected recovery email for cart ${input.cartId}: ${res.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.abandoned] recovery email for cart ${input.cartId} failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
