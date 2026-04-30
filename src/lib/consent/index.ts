/**
 * Cookie consent (v1.7).
 *
 * A small, dependency-free consent record stored in a first-party
 * cookie called `khaopad_consent`. Three categories:
 *
 *  - `functional` — always true (the cookie itself, the locale cookie,
 *     the auth session). Without these the site doesn't work; not
 *     consentable.
 *  - `analytics`  — privacy-friendly page-view counter (v1.8). Off
 *     until the visitor agrees.
 *  - `marketing`  — third-party tracking, embeds, pixels. Off until
 *     the visitor agrees.
 *
 * The schema is intentionally tiny so it round-trips through cookies
 * cheaply. The `ts` field lets us prompt for re-consent if we change
 * what we mean by each category.
 */
export type ConsentCategories = "analytics" | "marketing";

export interface ConsentRecord {
  /** ISO timestamp of the most recent decision. */
  ts: string;
  /** Visitor opted in to analytics? (false until explicit yes.) */
  analytics: boolean;
  /** Visitor opted in to marketing/3p tracking? */
  marketing: boolean;
  /** Schema version. Bump if the categories change to force re-consent. */
  v: number;
}

export const CONSENT_COOKIE = "khaopad_consent";
export const CONSENT_VERSION = 1;
/** 1 year — long enough to not be annoying, short enough to refresh consent. */
export const CONSENT_MAX_AGE_S = 60 * 60 * 24 * 365;

/** Fresh "no decision yet" record. The banner shows when this is the live state. */
export function emptyConsent(): ConsentRecord {
  return { ts: "", analytics: false, marketing: false, v: CONSENT_VERSION };
}

/** Parse a cookie value into a typed record. Tolerant of malformed input. */
export function parseConsent(raw: string | null | undefined): ConsentRecord {
  if (!raw) return emptyConsent();
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.v === "number" &&
      parsed.v === CONSENT_VERSION
    ) {
      return {
        ts: typeof parsed.ts === "string" ? parsed.ts : "",
        analytics: Boolean(parsed.analytics),
        marketing: Boolean(parsed.marketing),
        v: CONSENT_VERSION,
      };
    }
  } catch {
    // fall through
  }
  return emptyConsent();
}

/** Serialize a record for cookie write. */
export function serializeConsent(c: ConsentRecord): string {
  return encodeURIComponent(
    JSON.stringify({
      ts: c.ts,
      analytics: c.analytics,
      marketing: c.marketing,
      v: c.v,
    }),
  );
}

/** True when the visitor has not yet made a decision (banner should show). */
export function isUndecided(c: ConsentRecord): boolean {
  return !c.ts;
}
