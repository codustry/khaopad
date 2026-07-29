/**
 * Generic query contract — Phase 1 (#68 §D).
 *
 * One primitive, `find(collection, query)`, replacing the need for a
 * new pair of provider methods per entity. The 85-method
 * `ContentProvider` stays exactly as it is; this is additive, and the
 * existing methods keep working untouched.
 *
 * Params are deliberately Strapi-shaped (`populate` / `fields` /
 * `filters` / `sort` / pagination) because that is the vocabulary
 * every headless-CMS consumer already knows, and #68 §D calls for
 * Strapi-compatible query params on the public API.
 */

/** Operators supported in `filters`. Deliberately small. */
export type FilterOperator =
  | "$eq"
  | "$ne"
  | "$lt"
  | "$lte"
  | "$gt"
  | "$gte"
  | "$in"
  | "$notIn"
  | "$contains"
  | "$null"
  | "$notNull";

export type FilterValue = string | number | boolean | null;

/**
 * `{ status: { $eq: "published" }, publishedAt: { $lte: "2026-01-01" } }`
 *
 * Conditions across different fields AND together. A bare value is
 * sugar for `$eq`.
 */
export type Filters = Record<
  string,
  FilterValue | Partial<Record<FilterOperator, FilterValue | FilterValue[]>>
>;

/**
 * Nested populate spec.
 *
 * `true` populates the relation with its default field set.
 * An object narrows it and/or recurses:
 *   { category: true, tags: { fields: ["slug"] } }
 */
export type PopulateSpec = boolean | PopulateNode;

export interface PopulateNode {
  /** Scalar allowlist for the populated rows. */
  fields?: string[];
  /** Recurse into the target collection's own relations. */
  populate?: Record<string, PopulateSpec>;
  /**
   * For `localizations` relations: restrict to one locale. Ignored by
   * other relation kinds.
   */
  locale?: string;
}

export interface FindQuery {
  /** Scalar allowlist on the root rows. Omit for all selectable. */
  fields?: string[];
  filters?: Filters;
  /** `"publishedAt"` asc, `"-publishedAt"` desc. Multiple allowed. */
  sort?: string | string[];
  page?: number;
  /** Rows per page. Clamped to MAX_LIMIT. */
  limit?: number;
  populate?: Record<string, PopulateSpec>;
  /**
   * Restricts every `localizations` relation in the tree, unless a
   * node overrides it. Validated against the runtime supported-locale
   * list, not a compile-time enum (#68 §E).
   */
  locale?: string;
  /**
   * Scheduled-publishing guard: hide rows whose `publishedAt` is in the
   * future. A null `publishedAt` passes (treated as "publish
   * immediately when status is published"), matching
   * `listArticles({onlyPublished})`.
   *
   * This is a flag rather than a filter because it needs
   * `publishedAt IS NULL OR publishedAt <= now` — a disjunction the
   * AND-only `filters` grammar can't express. Public endpoints must
   * set it; without it, an embargoed post is readable early.
   */
  onlyPublished?: boolean;
}

/** A returned row: scalars, plus whatever populate attached. */
export type EntryRow = Record<string, unknown>;

export interface FindResult {
  data: EntryRow[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pageCount: number;
    /** Queries actually issued. Surfaced so N+1 regressions are visible. */
    queryCount?: number;
  };
}

/**
 * Depth cap. #68 §D calls for 2–3; Contentful caps include at 10 and
 * Hygraph uses a complexity budget. 3 is enough for
 * `brand → productLines → variants` while bounding fan-out.
 */
export const MAX_POPULATE_DEPTH = 3;

/** Page-size ceiling, matching the existing public API's cap. */
export const MAX_LIMIT = 100;

export const DEFAULT_LIMIT = 20;

/** Raised for malformed queries — mapped to HTTP 400 by callers. */
export class QueryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNKNOWN_COLLECTION"
      | "UNKNOWN_FIELD"
      | "UNKNOWN_RELATION"
      | "UNKNOWN_OPERATOR"
      | "DEPTH_EXCEEDED"
      | "INVALID_LOCALE"
      | "INVALID_SORT",
  ) {
    super(message);
    this.name = "QueryError";
  }
}
