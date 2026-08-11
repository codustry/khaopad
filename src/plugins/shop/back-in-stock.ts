/**
 * Back-in-stock notifications (v3.17, #160 Phase D4).
 *
 * Capture: the product page posts (variantId, email, locale) for a
 * sold-out variant → `subscribeBackInStock` (dedupe via the UNIQUE
 * (variant_id, email) index — INSERT OR IGNORE, so double-submits and
 * re-subscribes while still waiting are silent no-ops).
 *
 * Send: `notifyBackInStock` fires from the admin adjust-inventory
 * action whenever on_hand INCREASES. Best-effort batch over Resend
 * (same idiom as email.ts): capped at 50 recipients per restock,
 * each row marked `notifiedAt` BEFORE its send is attempted — a
 * Resend hiccup must never cause a double-mail on the next restock
 * (notify-once beats retry for marketing-adjacent mail).
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { backInStockSubscriptions } from "./schema-retention";
import {
  shopProductLocalizations,
  shopProducts,
  shopProductVariants,
} from "./schema";
import type { ResendEnv } from "./email";

/** Max notifications sent per restock event. */
export const BIS_NOTIFY_CAP = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SubscribeResult =
  | { ok: true; deduped: boolean }
  | { ok: false; error: "INVALID_EMAIL" | "UNKNOWN_VARIANT" };

/**
 * Add a (variant, email) pair to the waitlist.
 *
 * A previously NOTIFIED row for the same pair is replaced — being
 * mailed once must not block a customer from waiting for the *next*
 * restock. A pending (un-notified) row dedupes silently.
 */
export async function subscribeBackInStock(
  d1: D1Database,
  input: { variantId: string; email: string; locale?: string },
): Promise<SubscribeResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "INVALID_EMAIL" };

  const db = drizzle(d1);
  const variant = await db
    .select({ id: shopProductVariants.id })
    .from(shopProductVariants)
    .where(eq(shopProductVariants.id, input.variantId))
    .limit(1)
    .get();
  if (!variant) return { ok: false, error: "UNKNOWN_VARIANT" };

  // Clear an already-NOTIFIED row so the UNIQUE index admits the
  // re-sub. Pending rows are left alone — the INSERT OR IGNORE below
  // is what makes a duplicate pending subscribe a no-op.
  await db
    .delete(backInStockSubscriptions)
    .where(
      and(
        eq(backInStockSubscriptions.variantId, input.variantId),
        eq(backInStockSubscriptions.email, email),
        isNotNull(backInStockSubscriptions.notifiedAt),
      ),
    );

  const res = await d1
    .prepare(
      `INSERT OR IGNORE INTO back_in_stock_subscriptions
         (id, variant_id, email, locale, created_at, notified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
    )
    .bind(
      nanoid(),
      input.variantId,
      email,
      input.locale === "th" ? "th" : "en",
      new Date().toISOString(),
    )
    .run();
  const inserted = (res.meta as { changes?: number })?.changes ?? 1;
  return { ok: true, deduped: inserted === 0 };
}

function buildRestockHtml(
  locale: string,
  title: string,
  productUrl: string,
): string {
  const th = locale === "th";
  const heading = th ? "สินค้ากลับมาแล้ว!" : "Back in stock!";
  const body = th
    ? `${title} ที่คุณรอกลับมามีของแล้ว — สั่งซื้อได้เลยก่อนหมดอีกครั้ง`
    : `${title} is available again — grab it before it sells out.`;
  const cta = th ? "ดูสินค้า" : "View product";
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:#f7f7f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 8px;font-size:18px;">${escapeHtml(heading)}</h1>
          <p style="margin:0;color:#444;font-size:14px;">${escapeHtml(body)}</p>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <a href="${escapeHtml(productUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">${escapeHtml(cta)}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
 * Send restock mail for a variant. Called after an inventory write
 * that INCREASED on_hand. Best-effort by contract: returns the number
 * of subscribers processed, never throws into the admin action.
 *
 * Rows are marked notified in one batch UPDATE up front (notify-once),
 * then mailed individually; a failed send is logged and dropped.
 */
export async function notifyBackInStock(
  env: ResendEnv & { DB?: D1Database },
  d1: D1Database,
  variantId: string,
): Promise<number> {
  try {
    const db = drizzle(d1);
    const pending = await db
      .select()
      .from(backInStockSubscriptions)
      .where(
        and(
          eq(backInStockSubscriptions.variantId, variantId),
          isNull(backInStockSubscriptions.notifiedAt),
        ),
      )
      .limit(BIS_NOTIFY_CAP)
      .all();
    if (pending.length === 0) return 0;

    // No mail transport → leave rows PENDING (they'll go out on the
    // first restock after Resend is configured) rather than burning
    // them unnotified.
    const apiKey = await resolveResendKey(env);
    if (!apiKey || !env.RESEND_FROM) return 0;

    // Mark BEFORE sending — a crash mid-batch re-mails nobody
    // (notify-once beats retry for marketing-adjacent mail).
    const now = new Date().toISOString();
    for (const sub of pending) {
      await db
        .update(backInStockSubscriptions)
        .set({ notifiedAt: now })
        .where(eq(backInStockSubscriptions.id, sub.id));
    }

    // Product context for the mail — variant → product → localized title.
    const variantRow = await db
      .select({
        productId: shopProductVariants.productId,
        titleCached: shopProductVariants.titleCached,
        slug: shopProducts.slug,
      })
      .from(shopProductVariants)
      .innerJoin(
        shopProducts,
        eq(shopProducts.id, shopProductVariants.productId),
      )
      .where(eq(shopProductVariants.id, variantId))
      .limit(1)
      .get();
    if (!variantRow) return pending.length;
    const localizations = await db
      .select()
      .from(shopProductLocalizations)
      .where(eq(shopProductLocalizations.productId, variantRow.productId))
      .all();
    const titleFor = (locale: string) =>
      localizations.find((l) => l.locale === locale)?.title ??
      localizations.find((l) => l.locale === "en")?.title ??
      variantRow.slug;
    const siteUrl = env.PUBLIC_SITE_URL ?? "";

    for (const sub of pending) {
      const locale = sub.locale === "th" ? "th" : "en";
      const title = titleFor(locale);
      const productUrl = `${siteUrl}/${locale}/products/${variantRow.slug}`;
      const subject =
        locale === "th"
          ? `${title} กลับมามีของแล้ว`
          : `${title} is back in stock`;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: env.RESEND_FROM,
            to: [sub.email],
            subject,
            html: buildRestockHtml(locale, title, productUrl),
          }),
        });
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn(
            `[shop.bis] Resend rejected restock mail to ${sub.email}: ${res.status}`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[shop.bis] restock mail to ${sub.email} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return pending.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shop.bis] notifyBackInStock(${variantId}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}
