/**
 * Careers feed parsing + normalization — pure, network-free.
 *
 * The upstream is a third-party ATS (Tonbab People, `GET
 * /api/careers/{slug}/jobs`) that this codebase does not control and
 * cannot deploy in lockstep with. Every value crossing this boundary
 * is untrusted: fields may be missing, null, the wrong type, or
 * outright hostile. The rule for everything below is **degrade, never
 * throw** — a malformed job is dropped, a malformed feed yields an
 * empty list, and the marketing page still renders.
 *
 * Nothing here touches `fetch`, KV, or `Date.now()`, so the whole
 * contract is testable as plain function calls. The impure shell
 * (timeout, KV read/write, stale fallback) lives in `service.ts`.
 *
 * ## Security
 *
 * Feed strings are rendered as TEXT by the Svelte components — never
 * via `{@html}`. No sanitizer runs here because none is needed: the
 * only consumer that escapes into a non-text context is JSON-LD, and
 * `jsonld.ts` escapes `<` on the serialized string exactly as
 * `shop/jsonld.ts` does. `apply_url` is the one value that lands in an
 * attribute (`href`), so it is scheme-checked to http(s) — this is
 * what stops a `javascript:` URL in the feed from becoming a
 * same-origin script execution.
 */

/** Employment types we map to schema.org values. Anything else passes through as a label only. */
const EMPLOYMENT_TYPE_MAP: Record<string, string> = {
  full_time: "FULL_TIME",
  "full-time": "FULL_TIME",
  fulltime: "FULL_TIME",
  part_time: "PART_TIME",
  "part-time": "PART_TIME",
  parttime: "PART_TIME",
  contract: "CONTRACTOR",
  contractor: "CONTRACTOR",
  temporary: "TEMPORARY",
  intern: "INTERN",
  internship: "INTERN",
  volunteer: "VOLUNTEER",
  per_diem: "PER_DIEM",
  other: "OTHER",
};

export type CareersCategory = {
  slug: string;
  nameEn: string;
  nameTh: string;
};

export type CareersSalary = {
  min: number | null;
  max: number | null;
  currency: string;
};

export type CareersJob = {
  id: string;
  /** Human reference like "JOB-0001". Null when the feed omits it. */
  number: string | null;
  title: string;
  department: string | null;
  /** Raw feed value, e.g. "full_time" — used for the display label. */
  employmentType: string | null;
  /** schema.org employmentType, e.g. "FULL_TIME". Null when unmappable. */
  employmentTypeSchema: string | null;
  location: string | null;
  category: CareersCategory | null;
  salary: CareersSalary | null;
  /** ISO 8601 datetime, validated. Null when absent or unparseable. */
  publishedAt: string | null;
  /** Guaranteed http(s) absolute URL. */
  applyUrl: string;
};

export type CareersFeed = {
  company: string | null;
  jobs: CareersJob[];
};

/** The shape stored in KV. Versioned so a format change can't deserialize as valid. */
export type CachedCareersFeed = {
  v: 1;
  feed: CareersFeed;
  /** Epoch ms the entry was written. Supplied by the caller; not read here. */
  fetchedAt: number;
};

export const CAREERS_CACHE_VERSION = 1;

/** An always-safe value to render. Used whenever the feed cannot be trusted at all. */
export const EMPTY_FEED: CareersFeed = { company: null, jobs: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A non-empty trimmed string, or null. Numbers are NOT coerced — a
 * numeric `title` is a feed bug, and inventing `"42"` would hide it.
 * The one exception is `number`/`id`-ish fields handled explicitly.
 */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Like {@link str} but tolerates a numeric id/reference, which ATSs commonly emit. */
function idLike(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

/** Finite, non-negative number or null. Rejects NaN, Infinity, numeric strings that aren't. */
function num(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Only absolute http(s) URLs survive. This is the XSS gate for the
 * `href` on every "Apply" link: `javascript:`, `data:` and relative
 * paths are all rejected, and a job without a usable apply URL is
 * dropped entirely (a career card that cannot be applied to is noise).
 */
export function safeUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/** ISO 8601 datetime, echoed back only when it actually parses. */
export function safeIsoDate(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Map a feed employment_type onto a schema.org value; null when unrecognized. */
export function toSchemaEmploymentType(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  return EMPLOYMENT_TYPE_MAP[raw.toLowerCase()] ?? null;
}

/** "full_time" → "Full time". Display-only fallback when we have no Paraglide key. */
export function humanizeEmploymentType(value: string | null): string | null {
  if (!value) return null;
  const words = value.replace(/[_-]+/g, " ").trim();
  if (!words) return null;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function normalizeCategory(value: unknown): CareersCategory | null {
  if (!isRecord(value)) return null;
  const slug = str(value.slug);
  // Accepts both the feed spelling and our own — see `field()`.
  const nameEn = str(
    value.name_en !== undefined ? value.name_en : value.nameEn,
  );
  const nameTh = str(
    value.name_th !== undefined ? value.name_th : value.nameTh,
  );
  // A category with no usable label is not worth a chip. Either name
  // alone is enough — we fall back across locales at render time.
  const label = nameEn ?? nameTh;
  if (!label) return null;
  return {
    slug: slug ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    nameEn: nameEn ?? label,
    nameTh: nameTh ?? label,
  };
}

/**
 * `salary` is null unless the posting opted in (`show_salary`
 * upstream). A salary object with neither bound is treated as absent
 * rather than as a zero-to-zero range — emitting `baseSalary: 0` in
 * JSON-LD would be a factual claim we cannot support.
 */
function normalizeSalary(value: unknown): CareersSalary | null {
  if (!isRecord(value)) return null;
  const min = num(value.min);
  const max = num(value.max);
  if (min === null && max === null) return null;
  // A reversed range is a data error upstream; swap rather than drop
  // so the opening still shows a plausible band.
  const lo = min !== null && max !== null ? Math.min(min, max) : min;
  const hi = min !== null && max !== null ? Math.max(min, max) : max;
  const currency = str(value.currency)?.toUpperCase() ?? "THB";
  return { min: lo, max: hi, currency };
}

/**
 * Read a field by its feed name, falling back to the camelCase name
 * used by our own normalized shape.
 *
 * Both spellings are accepted because `normalizeFeed` runs in two
 * places: over a fresh upstream body (snake_case, as the ATS sends it)
 * and over a value read back out of KV, which is an
 * already-normalized `CareersFeed` (camelCase). Re-validating the
 * cached copy is deliberate — a tampered or stale-format entry must
 * face the same URL scheme check as a fresh fetch — and that only
 * works if normalization is idempotent across both key styles.
 */
function field(
  record: Record<string, unknown>,
  feedKey: string,
  ownKey: string,
): unknown {
  return record[feedKey] !== undefined ? record[feedKey] : record[ownKey];
}

/**
 * Normalize one job. Returns null when the entry lacks the minimum
 * viable fields (id, title, usable apply URL) — a card we cannot
 * identify, name, or link is dropped rather than rendered blank.
 */
export function normalizeJob(value: unknown): CareersJob | null {
  if (!isRecord(value)) return null;

  const id = idLike(value.id);
  const title = str(value.title);
  const applyUrl = safeUrl(field(value, "apply_url", "applyUrl"));
  if (!id || !title || !applyUrl) return null;

  const employmentType = str(field(value, "employment_type", "employmentType"));

  return {
    id,
    number: idLike(value.number),
    title,
    department: str(value.department),
    employmentType,
    employmentTypeSchema: toSchemaEmploymentType(employmentType),
    location: str(value.location),
    category: normalizeCategory(value.category),
    salary: normalizeSalary(value.salary),
    publishedAt: safeIsoDate(field(value, "published_at", "publishedAt")),
    applyUrl,
  };
}

/**
 * Normalize a decoded feed payload. Never throws.
 *
 * Accepts either the documented `{ company, jobs: [...] }` envelope or
 * a bare array of jobs — some ATS exports omit the envelope, and
 * tolerating it costs one branch.
 */
export function normalizeFeed(payload: unknown): CareersFeed {
  if (Array.isArray(payload)) {
    return { company: null, jobs: normalizeJobs(payload) };
  }
  if (!isRecord(payload)) return { ...EMPTY_FEED };
  const jobs = Array.isArray(payload.jobs) ? normalizeJobs(payload.jobs) : [];
  return { company: str(payload.company), jobs };
}

function normalizeJobs(raw: unknown[]): CareersJob[] {
  const jobs: CareersJob[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const job = normalizeJob(entry);
    if (!job) continue;
    // Duplicate ids would break Svelte's keyed each and double-count
    // openings. First occurrence wins.
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
  }
  return sortJobs(jobs);
}

/**
 * Newest first, with undated postings last (an undated job sorting to
 * the top of a careers page reads as stale). Ties break on title so
 * the order is deterministic — required for stable cache payloads.
 */
export function sortJobs(jobs: CareersJob[]): CareersJob[] {
  return [...jobs].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : null;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : null;
    if (at !== null && bt !== null && at !== bt) return bt - at;
    if (at !== null && bt === null) return -1;
    if (at === null && bt !== null) return 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Parse a raw response body. Malformed JSON yields the empty feed
 * rather than an exception — the caller distinguishes "upstream broke"
 * from "upstream has no openings" via the returned `ok` flag, not via
 * try/catch.
 */
export function parseFeedBody(body: string): {
  ok: boolean;
  feed: CareersFeed;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return { ok: false, feed: { ...EMPTY_FEED } };
  }
  // A JSON scalar (`"nope"`, `null`, `7`) is structurally not a feed.
  if (!isRecord(decoded) && !Array.isArray(decoded)) {
    return { ok: false, feed: { ...EMPTY_FEED } };
  }
  return { ok: true, feed: normalizeFeed(decoded) };
}

/**
 * Distinct categories across the openings, in first-appearance order.
 * Drives the filter chips; deriving it here (rather than trusting a
 * separate feed field) guarantees every chip matches at least one job.
 */
export function collectCategories(jobs: CareersJob[]): CareersCategory[] {
  const byslug = new Map<string, CareersCategory>();
  for (const job of jobs) {
    if (job.category && !byslug.has(job.category.slug)) {
      byslug.set(job.category.slug, job.category);
    }
  }
  return Array.from(byslug.values());
}

/** Filter by category slug. An unknown slug yields an empty list, not everything. */
export function filterByCategory(
  jobs: CareersJob[],
  slug: string | null,
): CareersJob[] {
  if (!slug) return jobs;
  return jobs.filter((job) => job.category?.slug === slug);
}

/** Locale-appropriate category label, falling back to the other locale. */
export function categoryLabel(
  category: CareersCategory,
  locale: string,
): string {
  return locale === "th"
    ? (category.nameTh ?? category.nameEn)
    : (category.nameEn ?? category.nameTh);
}

/**
 * Validate a value read back out of KV. A cache entry written by an
 * older build (or corrupted) must be treated as a miss, not trusted —
 * the payload is re-normalized so even a tampered entry cannot inject
 * an unsafe `applyUrl`.
 */
export function parseCachedFeed(value: unknown): CachedCareersFeed | null {
  if (!isRecord(value)) return null;
  if (value.v !== CAREERS_CACHE_VERSION) return null;
  if (!isRecord(value.feed)) return null;
  const fetchedAt = typeof value.fetchedAt === "number" ? value.fetchedAt : 0;
  return {
    v: CAREERS_CACHE_VERSION,
    feed: normalizeFeed(value.feed),
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0,
  };
}
