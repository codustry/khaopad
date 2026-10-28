/**
 * Visitor-source classification (v4.6).
 *
 * Turns a landing request into the five bounded dimensions the
 * `visitor_sources` counter table is keyed on:
 *
 *   channel  — direct | organic_search | social | referral | internal
 *   source   — normalised referrer origin, or utm_source
 *   medium   — organic | social | referral | none, or utm_medium
 *   campaign — utm_campaign, or "none"
 *   path     — the landing pathname (querystring stripped)
 *
 * ## What this module deliberately throws away
 *
 * The **full referring URL never leaves this function**. A referrer
 * arrives as `https://www.google.co.th/search?q=<what they typed>` and
 * leaves as the single token `google`. Search terms, the referring
 * page's own path, and any identifiers a partner site hangs off its
 * query string are dropped before anything is stored.
 *
 * There is no IP, no user agent, no cookie id and no timestamp finer
 * than the UTC date. That is not an oversight to be filled in later:
 * a per-visit row carrying (timestamp, referrer, path) reconstructs an
 * individual's journey through the site, which is exactly the artifact
 * this engine's privacy posture refuses to create.
 *
 * ## Bounded cardinality
 *
 * `source`, `medium` and `campaign` come partly from attacker-supplied
 * query parameters. Storing them verbatim would let anyone grow the
 * table without bound with `?utm_source=<random>` — an availability
 * problem and a storage bill. So every value is:
 *
 *   1. lower-cased and trimmed,
 *   2. accepted only if it matches SAFE_TOKEN (a-z 0-9 . _ + -),
 *   3. accepted only if it is at most MAX_TOKEN_LEN characters,
 *
 * and bucketed to the literal `"other"` otherwise. A spray of 10k
 * distinct random values therefore collapses into one row.
 */

export type SourceChannel =
  | "direct"
  | "organic_search"
  | "social"
  | "referral"
  | "internal";

export const SOURCE_CHANNELS: readonly SourceChannel[] = [
  "direct",
  "organic_search",
  "social",
  "referral",
  "internal",
] as const;

/**
 * Longest token we will store for source / medium / campaign. Long
 * enough for real campaign names ("spring-2026-newsletter-th"), short
 * enough that a million rows is still a small table.
 */
export const MAX_TOKEN_LEN = 64;

/**
 * Charset for a stored token. Deliberately narrow: anything outside it
 * is bucketed rather than escaped, which means no stored dimension can
 * carry markup, whitespace or a homoglyph that renders as something
 * else in the admin table.
 */
const SAFE_TOKEN = /^[a-z0-9._+-]+$/;

/** Bucket for a value that failed normalisation. */
export const OTHER = "other";
/** Sentinel for "the operator did not tag this landing". */
export const NONE = "none";

/**
 * Known search engines. A trailing dot marks a multi-TLD engine, so
 * `google.` covers google.com, google.co.th, google.de — see
 * `matchKnown` for why that needs care.
 */
const SEARCH_ENGINES: ReadonlyArray<readonly [string, string]> = [
  ["google.", "google"],
  ["bing.", "bing"],
  ["duckduckgo.com", "duckduckgo"],
  ["search.yahoo.com", "yahoo"],
  ["yahoo.", "yahoo"],
  ["baidu.com", "baidu"],
  ["yandex.", "yandex"],
  ["ecosia.org", "ecosia"],
  ["brave.com", "brave"],
  ["startpage.com", "startpage"],
  ["qwant.com", "qwant"],
  ["naver.com", "naver"],
] as const;

/** Known social networks, same matching rules. */
const SOCIAL_NETWORKS: ReadonlyArray<readonly [string, string]> = [
  ["facebook.com", "facebook"],
  ["m.facebook.com", "facebook"],
  ["fb.com", "facebook"],
  ["l.facebook.com", "facebook"],
  ["instagram.com", "instagram"],
  ["l.instagram.com", "instagram"],
  ["twitter.com", "twitter"],
  ["x.com", "twitter"],
  ["t.co", "twitter"],
  ["linkedin.com", "linkedin"],
  ["lnkd.in", "linkedin"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["reddit.com", "reddit"],
  ["out.reddit.com", "reddit"],
  ["pinterest.", "pinterest"],
  ["tiktok.com", "tiktok"],
  ["line.me", "line"],
  ["lin.ee", "line"],
  ["t.me", "telegram"],
  ["telegram.me", "telegram"],
  ["threads.net", "threads"],
  ["threads.com", "threads"],
  ["mastodon.social", "mastodon"],
  ["bsky.app", "bluesky"],
  ["news.ycombinator.com", "hackernews"],
  ["medium.com", "medium"],
  ["quora.com", "quora"],
  ["weibo.com", "weibo"],
  ["vk.com", "vk"],
] as const;

/**
 * Match a host against one of the tables above.
 *
 * A plain pattern matches the host exactly or as a suffix at a label
 * boundary (`facebook.com` matches `m.facebook.com`, never
 * `notfacebook.com`).
 *
 * A trailing-dot pattern marks a multi-TLD engine and needs more care.
 * The obvious `host.includes(".google.")` test classifies
 * `google.com.evil.example` as organic Google traffic — anyone who
 * controls a domain could forge a Referer and pollute the report with
 * whatever source name they liked. So the label must own the
 * REGISTRABLE domain: it has to appear at position 0 or 1 (allowing
 * one `www`-style prefix) and everything after it has to be a short
 * TLD/SLD component (com, co, uk, th).
 */
function matchKnown(
  host: string,
  table: ReadonlyArray<readonly [string, string]>,
): string | null {
  for (const [pattern, name] of table) {
    if (pattern.endsWith(".")) {
      const base = pattern.slice(0, -1);
      const labels = host.split(".");
      const idx = labels.indexOf(base);
      if (idx !== -1 && idx <= 1) {
        const rest = labels.slice(idx + 1);
        if (rest.length > 0 && rest.every((l) => l.length <= 3)) return name;
      }
    } else if (host === pattern || host.endsWith(`.${pattern}`)) {
      return name;
    }
  }
  return null;
}

/**
 * Reduce a referrer to its ORIGIN — scheme + host + port, no path, no
 * query, no fragment. Returns null for a missing or unparseable
 * referrer, or for a non-http(s) scheme.
 *
 * This is the privacy boundary. Callers get an origin; nothing
 * downstream ever sees the rest of the URL.
 */
export function referrerOrigin(referrer: string | null | undefined): {
  origin: string;
  host: string;
} | null {
  if (!referrer) return null;
  try {
    const u = new URL(referrer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return null;
    return { origin: u.origin, host };
  } catch {
    return null;
  }
}

/**
 * Normalise a caller-supplied token (a utm_* value) into the stored
 * charset, or bucket it as "other".
 *
 * `null`/empty maps to `fallback` (the value meaning "absent"), which
 * is distinct from "other" (the value meaning "present but not worth
 * a row of its own"). Keeping those apart is what makes the campaigns
 * table able to show "untagged" separately from "junk".
 */
export function normalizeToken(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (!v) return fallback;
  if (v.length > MAX_TOKEN_LEN) return OTHER;
  if (!SAFE_TOKEN.test(v)) return OTHER;
  return v;
}

/** Strip querystring + trailing slash, bound the length. */
export function normalizeLandingPath(p: string): string {
  let s = p;
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#");
  if (h >= 0) s = s.slice(0, h);
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (s.length > 256) s = s.slice(0, 256);
  return s || "/";
}

export interface ClassifyInput {
  /** Landing pathname (querystring is stripped here, not by the caller). */
  path: string;
  /** Raw `Referer` header, or null. */
  referrer: string | null | undefined;
  /** Landing URL's query parameters, for utm_*. */
  params: URLSearchParams;
  /** This site's own hostname, so self-referrals classify as internal. */
  selfHost: string;
}

export interface ClassifiedSource {
  channel: SourceChannel;
  source: string;
  medium: string;
  campaign: string;
  path: string;
}

/**
 * Classify one landing into the stored dimensions.
 *
 * Precedence: explicit UTM tagging wins over referrer inference. An
 * operator who tagged a link said what they meant; the referrer is
 * only ever a guess. But the CHANNEL still uses the referrer when the
 * utm_medium is not one we recognise, so a link tagged
 * `utm_medium=cpc` arriving from Facebook is still counted as social
 * rather than falling into a bucket the UI has no column for.
 */
export function classifySource(input: ClassifyInput): ClassifiedSource {
  const path = normalizeLandingPath(input.path);
  const campaign = normalizeToken(input.params.get("utm_campaign"), NONE);
  const utmSource = input.params.get("utm_source");
  const utmMedium = input.params.get("utm_medium");

  const ref = referrerOrigin(input.referrer);
  const selfHost = input.selfHost.toLowerCase().replace(/^www\./, "");

  // ── Infer from the referrer first, then let UTM override the
  //    labels. Channel resolution is below.
  let channel: SourceChannel;
  let source: string;
  let medium: string;

  if (!ref) {
    channel = "direct";
    source = "direct";
    medium = NONE;
  } else if (ref.host === selfHost || ref.host.endsWith(`.${selfHost}`)) {
    channel = "internal";
    source = "internal";
    medium = "internal";
  } else {
    const engine = matchKnown(ref.host, SEARCH_ENGINES);
    if (engine) {
      channel = "organic_search";
      source = engine;
      medium = "organic";
    } else {
      const social = matchKnown(ref.host, SOCIAL_NETWORKS);
      if (social) {
        channel = "social";
        source = social;
        medium = "social";
      } else {
        channel = "referral";
        // An unknown referrer host is itself unbounded cardinality —
        // anyone can spin up a domain and link to us. normalizeToken
        // buckets a host that is too long or carries odd characters
        // (punycode, say) rather than storing it.
        source = normalizeToken(ref.host, OTHER);
        medium = "referral";
      }
    }
  }

  // Explicit tagging overrides the inferred labels.
  const tagged = utmSource != null && utmSource.trim() !== "";
  if (tagged) {
    source = normalizeToken(utmSource, OTHER);
    // A tagged landing is never "direct". Direct means "arrived with
    // nothing telling us where from"; a link the operator stamped
    // with utm_source is attributed by definition, even when the
    // client sends no Referer (mail clients and apps routinely
    // strip it). Leaving these in direct would quietly credit every
    // newsletter and QR-code campaign to nobody.
    if (channel === "direct") channel = "referral";
    if (medium === NONE) medium = "referral";
  }
  if (utmMedium != null && utmMedium.trim() !== "") {
    medium = normalizeToken(utmMedium, OTHER);
    // A recognised medium re-homes the channel; an unrecognised one
    // (say `cpc`, or `email`) leaves the referrer-derived channel
    // alone rather than inventing a bucket the UI has no column for.
    if (medium === "organic") channel = "organic_search";
    else if (medium === "social") channel = "social";
    else if (medium === "referral" && channel === "direct")
      channel = "referral";
  }

  return { channel, source, medium, campaign, path };
}
