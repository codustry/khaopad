/**
 * Strapi-compatible query-param parsing — Phase 1 (#68 §D).
 *
 * Translates URL params into a `FindQuery`. The vocabulary is
 * deliberately Strapi's, because that's what headless consumers and
 * their client libraries already speak:
 *
 *   ?populate=category,tags
 *   ?populate=category.parent          → nested via dot path
 *   ?fields=slug,status
 *   ?filters[status][$eq]=published
 *   ?filters[publishedAt][$lte]=2026-01-01
 *   ?sort=-publishedAt,slug
 *   ?page=2&limit=50
 *   ?locale=th
 *
 * Everything here is untrusted input, so parsing is strict: unknown
 * shapes raise `QueryError` (→ HTTP 400) rather than being ignored.
 * Silently dropping a malformed filter is the dangerous failure —
 * a caller asking for `status=published` and getting drafts because
 * their bracket syntax was wrong is worse than an error.
 */
import {
  QueryError,
  type Filters,
  type FilterOperator,
  type FindQuery,
  type PopulateNode,
  type PopulateSpec,
} from "./types";

const OPERATORS = new Set<string>([
  "$eq",
  "$ne",
  "$lt",
  "$lte",
  "$gt",
  "$gte",
  "$in",
  "$notIn",
  "$contains",
  "$null",
  "$notNull",
]);

/** Guards against a pathological `?populate=a.b.c.d.e.f…` blowing the parser. */
const MAX_PATH_SEGMENTS = 8;

/**
 * `category,tags` or `category.parent,tags` → nested populate tree.
 *
 * Depth is enforced later by the engine (which knows MAX_POPULATE_DEPTH);
 * here we only bound the raw string so parsing itself stays cheap.
 */
export function parsePopulate(
  raw: string | null,
): Record<string, PopulateSpec> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // `populate=*` — every relation, one level. Matches Strapi.
  if (trimmed === "*") return { "*": true };

  const tree: Record<string, PopulateSpec> = {};
  for (const path of trimmed.split(",")) {
    const segments = path.trim().split(".").filter(Boolean);
    if (segments.length === 0) continue;
    if (segments.length > MAX_PATH_SEGMENTS) {
      throw new QueryError(
        `Populate path "${path}" has too many segments`,
        "DEPTH_EXCEEDED",
      );
    }

    let cursor = tree;
    segments.forEach((segment, i) => {
      const last = i === segments.length - 1;
      if (last) {
        // Don't clobber a branch already created by a sibling path.
        if (cursor[segment] === undefined) cursor[segment] = true;
        return;
      }
      const existing = cursor[segment];
      const node: PopulateNode =
        existing && typeof existing === "object" ? existing : {};
      if (!node.populate) node.populate = {};
      cursor[segment] = node;
      cursor = node.populate;
    });
  }
  return Object.keys(tree).length ? tree : undefined;
}

/** `slug,status` → ["slug","status"] */
export function parseFields(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const fields = raw
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  return fields.length ? fields : undefined;
}

/** `-publishedAt,slug` → ["-publishedAt","slug"] */
export function parseSort(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const specs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return specs.length ? specs : undefined;
}

/**
 * Collects `filters[field][$op]=value` across all search params.
 *
 * Also accepts the shorthand `filters[field]=value` (implicit `$eq`).
 * Repeated keys accumulate into an array, so
 * `filters[id][$in]=a&filters[id][$in]=b` works as expected.
 */
export function parseFilters(params: URLSearchParams): Filters | undefined {
  const filters: Filters = {};
  let found = false;

  for (const [key, value] of params.entries()) {
    if (!key.startsWith("filters[")) continue;

    const path = parseBracketPath(key);
    if (!path || path.length === 0 || path.length > 2) {
      throw new QueryError(
        `Malformed filter parameter "${key}"`,
        "UNKNOWN_OPERATOR",
      );
    }

    const [field, op] = path;
    found = true;

    if (op === undefined) {
      filters[field] = coerce(value);
      continue;
    }
    if (!OPERATORS.has(op)) {
      throw new QueryError(`Unknown operator "${op}"`, "UNKNOWN_OPERATOR");
    }

    const existing = filters[field];
    const bucket: Partial<Record<FilterOperator, unknown>> =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Partial<Record<FilterOperator, unknown>>)
        : {};

    const operator = op as FilterOperator;
    const prior = bucket[operator];
    if (prior === undefined) {
      bucket[operator] = coerce(value);
    } else if (Array.isArray(prior)) {
      prior.push(coerce(value));
    } else {
      bucket[operator] = [prior, coerce(value)];
    }
    filters[field] = bucket as Filters[string];
  }

  return found ? filters : undefined;
}

/** `filters[status][$eq]` → ["status","$eq"] */
function parseBracketPath(key: string): string[] | null {
  const inner = key.slice("filters".length);
  const parts: string[] = [];
  const re = /\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = re.exec(inner)) !== null) {
    if (match.index !== consumed) return null; // gap → malformed
    if (!match[1]) return null; // empty bracket
    parts.push(match[1]);
    consumed = re.lastIndex;
  }
  if (consumed !== inner.length) return null; // trailing junk
  return parts;
}

/**
 * URL params are strings; filters are compared against typed columns.
 * Coerce the unambiguous cases so `?filters[size][$gt]=100` compares
 * numerically rather than lexicographically ("9" > "100" as text).
 *
 * Deliberately conservative: only exact `true`/`false`/`null` and
 * finite numbers convert. Anything else stays a string, so an id like
 * `0123` isn't silently mangled into 123.
 */
function coerce(value: string): string | number | boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value !== "" && /^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    // Reject anything that wouldn't round-trip (leading zeros, overflow).
    if (Number.isFinite(n) && String(n) === value) return n;
  }
  return value;
}

/** Parse a full `FindQuery` off a request URL. */
export function parseFindQuery(
  url: URL,
  defaults: { limit?: number } = {},
): FindQuery {
  const p = url.searchParams;
  const limitRaw = p.get("limit") ?? p.get("pageSize");
  const pageRaw = p.get("page");

  return {
    fields: parseFields(p.get("fields")),
    filters: parseFilters(p),
    sort: parseSort(p.get("sort")),
    populate: parsePopulate(p.get("populate")),
    locale: p.get("locale") ?? undefined,
    limit: limitRaw ? Number(limitRaw) || defaults.limit : defaults.limit,
    page: pageRaw ? Number(pageRaw) || 1 : 1,
  };
}
