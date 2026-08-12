/**
 * Careers feed service — the impure shell around `feed.ts`.
 *
 * Owns exactly three things the pure parser cannot: the timed network
 * call, the `CONTENT_CACHE` KV round trip, and the stale-on-error
 * decision. All parsing and validation stays in `feed.ts` so it can be
 * tested without a network or a KV binding.
 *
 * ## The resilience contract
 *
 * `loadCareersFeed` **never rejects**. Every failure mode — DNS, TLS,
 * 500, 404, hung socket, malformed JSON, KV outage — resolves to a
 * `CareersFeedResult` carrying the best data available:
 *
 *   1. Fresh upstream response  → `status: "live"`
 *   2. Unexpired KV entry       → `status: "cached"`
 *   3. Expired KV entry, after upstream failed → `status: "stale"`
 *   4. Nothing anywhere         → `status: "unavailable"`, empty jobs
 *
 * (4) renders the same friendly empty state as a genuinely empty
 * feed, so an ATS outage degrades a marketing page to "no openings
 * listed" instead of a 500. That is the entire point of this module:
 * the careers page's availability must not be coupled to a third
 * party's.
 *
 * The stale window is deliberately much longer than the fresh TTL —
 * a day-old list of real jobs beats an empty page during an outage.
 */
import {
  EMPTY_FEED,
  parseCachedFeed,
  parseFeedBody,
  type CachedCareersFeed,
  type CareersFeed,
  CAREERS_CACHE_VERSION,
} from "./feed";

/** Fresh-serve window. Matches the content cache's default (cache.ts). */
export const CAREERS_TTL_SECONDS = 300;

/**
 * How long an entry stays usable as a *fallback* after it goes stale.
 * KV keeps the record this long; between TTL and this bound we still
 * hit upstream first and only fall back on failure.
 */
export const CAREERS_STALE_TTL_SECONDS = 60 * 60 * 24; // 24h

/**
 * Upstream budget. A hung ATS must not hold a Worker request open —
 * Cloudflare would eventually kill the invocation and the visitor
 * would get a platform error page instead of our empty state.
 */
export const CAREERS_FETCH_TIMEOUT_MS = 4000;

/** KV rejects TTLs under 60s (same constraint as the content cache). */
const MIN_KV_TTL_SECONDS = 60;

export type CareersFeedStatus = "live" | "cached" | "stale" | "unavailable";

export type CareersFeedResult = {
  feed: CareersFeed;
  status: CareersFeedStatus;
  /** Epoch ms the served data was fetched from upstream. Null when never. */
  fetchedAt: number | null;
};

export type LoadCareersFeedOptions = {
  feedUrl: string;
  kv?: KVNamespace | null;
  ttlSeconds?: number;
  timeoutMs?: number;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to Date.now. */
  now?: () => number;
};

/**
 * Cache key is derived from the feed URL so two installs (or a staging
 * URL swap) cannot read each other's entries out of a shared
 * namespace. Version prefix lets a payload-shape change orphan old
 * entries without enumerating keys.
 */
export function careersCacheKey(feedUrl: string): string {
  return `careers:v${CAREERS_CACHE_VERSION}:${hash(feedUrl)}`;
}

/** FNV-1a — same rationale as `content/query/cache.ts`: fast, non-crypto, collision-tolerant. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Fetch with a hard timeout. Resolves to the body text, or null on any
 * failure including a non-2xx status. Never throws.
 */
export async function fetchFeedBody(
  feedUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? CAREERS_FETCH_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(feedUrl, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      // The ATS feed is public and read-only; no credentials ever.
      redirect: "follow",
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    // AbortError, network error, body read error — all the same to us.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(
  kv: KVNamespace,
  key: string,
): Promise<CachedCareersFeed | null> {
  try {
    const raw = await kv.get(key, "json");
    return parseCachedFeed(raw);
  } catch {
    // A KV read failure must never break a page render.
    return null;
  }
}

async function writeCache(
  kv: KVNamespace,
  key: string,
  entry: CachedCareersFeed,
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(entry), {
      // Keep the record alive well past its fresh TTL so it can serve
      // as the stale fallback; freshness is decided by `fetchedAt`,
      // not by KV expiry.
      expirationTtl: Math.max(MIN_KV_TTL_SECONDS, CAREERS_STALE_TTL_SECONDS),
    });
  } catch {
    /* best-effort — a failed cache write is not a failed request */
  }
}

/**
 * Load the careers feed, cached and outage-tolerant. Never rejects.
 */
export async function loadCareersFeed(
  options: LoadCareersFeedOptions,
): Promise<CareersFeedResult> {
  const {
    feedUrl,
    kv = null,
    ttlSeconds = CAREERS_TTL_SECONDS,
    timeoutMs = CAREERS_FETCH_TIMEOUT_MS,
    fetchImpl,
    now = Date.now,
  } = options;

  const key = careersCacheKey(feedUrl);
  const cached = kv ? await readCache(kv, key) : null;

  // ── 1. Fresh cache hit — skip the network entirely ──
  if (cached && now() - cached.fetchedAt < ttlSeconds * 1000) {
    return {
      feed: cached.feed,
      status: "cached",
      fetchedAt: cached.fetchedAt,
    };
  }

  // ── 2. Go upstream ──
  const body = await fetchFeedBody(feedUrl, { timeoutMs, fetchImpl });
  if (body !== null) {
    const parsed = parseFeedBody(body);
    if (parsed.ok) {
      const fetchedAt = now();
      if (kv) {
        await writeCache(kv, key, {
          v: CAREERS_CACHE_VERSION,
          feed: parsed.feed,
          fetchedAt,
        });
      }
      return { feed: parsed.feed, status: "live", fetchedAt };
    }
    // Body arrived but was not valid JSON / not a feed shape. Treat it
    // exactly like an outage — a garbled 200 is not better news than a
    // 500, and overwriting good cached jobs with nothing would be worse.
  }

  // ── 3. Upstream failed: serve stale if we have anything ──
  if (cached) {
    return { feed: cached.feed, status: "stale", fetchedAt: cached.fetchedAt };
  }

  // ── 4. Nothing anywhere. Empty state, HTTP 200. ──
  return { feed: { ...EMPTY_FEED }, status: "unavailable", fetchedAt: null };
}

/**
 * Read the configured feed URL. Returns null when unset or unusable,
 * which the route turns into a 404 — an install that never configured
 * careers should behave as though the feature does not exist, not
 * publish an empty careers page it never asked for.
 */
export function resolveFeedUrl(
  env: { CAREERS_FEED_URL?: string } | undefined,
): string | null {
  const raw = env?.CAREERS_FEED_URL;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
