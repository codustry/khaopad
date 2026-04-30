import type { ContentProvider, PageRecord } from "./types";

/**
 * Markdown templates for the privacy and cookie policies, embedded
 * in source so the CMS can seed them with no filesystem access at
 * Worker runtime (R2 / KV would be overkill for a few KB).
 *
 * The on-disk versions in `static/legal-templates/*.md` are the
 * canonical reference; this module is a copy that's served from
 * runtime memory. Keep them in sync when editing.
 */

const PRIVACY_POLICY_TEMPLATE_EN = `# Privacy Policy

> **⚠️ This is a template seeded by Khao Pad.** Replace every \`[bracketed placeholder]\` with your actual practices, then have a lawyer review before publishing.

_Last updated: [Date]_

## Who we are

[Site Name] is operated by [Operator Legal Entity], registered at [Operator Address], reachable at [Contact Email].

For questions about your personal data, contact [DPO or Privacy Contact Email].

## What data we collect

- **Account data** — when you create an account: email, name, hashed password.
- **Session data** — a session cookie set by Better Auth so you stay signed in.
- **Cookie consent** — your choices in the cookie banner are stored in a first-party cookie called \`khaopad_consent\`.
- **Analytics data** — _only if you opt in_: counts of which pages are visited, by day. We do not store IP addresses or user agents.

## Why we collect it

- **Account / Session** — to authenticate you and keep you signed in. Legal basis: contract performance.
- **Analytics** — to understand which content is read. Legal basis: consent.

## Who we share it with

We use the following processors:

- **Cloudflare** (Workers, D1, R2, KV) — hosting and storage.
- **Better Auth** — authentication library running inside our worker. No external service.

We do **not** sell personal data.

## Your rights

Depending on your jurisdiction (GDPR, PDPA, CCPA, etc.) you have rights to:

- access the personal data we hold about you,
- ask us to correct it,
- ask us to delete it,
- object to specific processing,
- withdraw consent for analytics at any time via the cookie banner.

To exercise these rights email [DPO or Privacy Contact Email].

## Cookies

See the separate [Cookie Policy](/[locale]/cookie-policy) for the full list of cookies.

## Contact

[Operator Legal Entity]
[Operator Address]
[Contact Email]
`;

const COOKIE_POLICY_TEMPLATE_EN = `# Cookie Policy

> **⚠️ This is a template seeded by Khao Pad.** Edit the cookie list to match what your specific deployment actually sets. The defaults reflect a stock Khao Pad install.

_Last updated: [Date]_

## What are cookies?

A cookie is a small text file stored on your device by your browser. We use them to keep you signed in, remember your language preference, and (if you opt in) count page views.

## Functional cookies (always on)

| Cookie name           | Purpose                                                       | Lifetime |
| --------------------- | ------------------------------------------------------------- | -------- |
| \`better-auth.session\` | Authentication session — keeps you signed in after login    | 30 days  |
| \`PARAGLIDE_LOCALE\`    | Remembers your language choice                               | 1 year   |
| \`khaopad_consent\`     | Stores your decision in the cookie banner                    | 1 year   |

## Analytics cookies (off until you accept)

Set only if you check **Analytics** in the banner.

We do **not** use Google Analytics, Facebook Pixel, or any other third-party tracker by default.

## Marketing cookies (off until you accept)

Set only if you check **Marketing** in the banner. (None by default.)

## Changing your choices

Use the cookie banner that appears the first time you visit, or clear the \`khaopad_consent\` cookie to see the banner again.

## Questions

[Contact Email]
`;

/**
 * Seed legal pages (privacy-policy + cookie-policy) for a fresh
 * install. Idempotent: skips templates whose slug already exists.
 *
 * Pre-fills `[Site Name]` and `[Contact Email]` from `site_settings`
 * when those values are present; everything else stays bracketed for
 * the operator to edit. The new pages start in draft status — they
 * never auto-publish, even if the seed runs.
 */
export async function seedLegalPages(
  content: ContentProvider,
  authorId: string,
): Promise<{
  created: PageRecord[];
  skipped: Array<{ slug: string; reason: string }>;
}> {
  const settings = await content.getSettings().catch(() => null);
  const siteName = settings?.siteName ?? "[Site Name]";

  const templates = [
    {
      slug: "privacy-policy",
      title: "Privacy Policy",
      template: "legal" as const,
      body: PRIVACY_POLICY_TEMPLATE_EN.replace(/\[Site Name\]/g, siteName),
    },
    {
      slug: "cookie-policy",
      title: "Cookie Policy",
      template: "legal" as const,
      body: COOKIE_POLICY_TEMPLATE_EN,
    },
  ];

  const created: PageRecord[] = [];
  const skipped: Array<{ slug: string; reason: string }> = [];
  for (const t of templates) {
    const existing = await content.getPageBySlug(t.slug);
    if (existing) {
      skipped.push({ slug: t.slug, reason: "already exists" });
      continue;
    }
    const page = await content.createPage({
      slug: t.slug,
      template: t.template,
      status: "draft",
      authorId,
      localizations: {
        en: {
          title: t.title,
          body: t.body,
          seoTitle: t.title,
          seoDescription: `${t.title} for ${siteName}.`,
        },
      },
    });
    created.push(page);
  }
  return { created, skipped };
}
