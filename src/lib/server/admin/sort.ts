/**
 * Column sorting for admin index pages (#160 C5).
 *
 * ## Why in-memory, not SQL ORDER BY
 *
 * Every admin index loads a capped page (50–100 rows) and already
 * filters search matches in memory. Sorting the same in-memory page
 * keeps this module trivially injection-proof: the `sort` query
 * parameter is only ever used as a key into a comparator map the
 * caller declares literally — it is never interpolated into SQL, and
 * an unknown key is a no-op rather than an error. When real
 * server-side pagination lands, this seam is where an ORDER-BY
 * whitelist would move to.
 */

export type SortDir = "asc" | "desc";

/** Whitelist of sortable keys → comparator. Declared literally per page. */
export type SortSpec<T> = Record<string, (a: T, b: T) => number>;

/**
 * Read `?sort=` / `?dir=` from the URL. `sort` values outside the
 * whitelist collapse to `null` (unsorted); `dir` is anything-but-desc
 * → asc.
 */
export function parseSort(
  url: URL,
  whitelist: readonly string[],
): { sort: string | null; dir: SortDir } {
  const raw = url.searchParams.get("sort");
  const sort = raw && whitelist.includes(raw) ? raw : null;
  const dir: SortDir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
  return { sort, dir };
}

/**
 * Return a sorted copy of `rows`. Unknown/absent sort keys return the
 * input untouched — the page's natural order (usually newest-first
 * from the service) is a fine default.
 */
export function sortRows<T>(
  rows: T[],
  comparators: SortSpec<T>,
  sort: string | null,
  dir: SortDir,
): T[] {
  if (!sort) return rows;
  // hasOwnProperty guard so `sort=constructor` etc. cannot reach up
  // the prototype chain and "compare" with something that isn't a
  // declared comparator.
  if (!Object.prototype.hasOwnProperty.call(comparators, sort)) return rows;
  const cmp = comparators[sort];
  const sorted = [...rows].sort(cmp);
  if (dir === "desc") sorted.reverse();
  return sorted;
}

/** Comparator over a string field (locale-aware, nulls last). */
export function byString<T>(get: (row: T) => string | null | undefined) {
  return (a: T, b: T): number => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av.localeCompare(bv);
  };
}

/** Comparator over a numeric field (nulls last). */
export function byNumber<T>(get: (row: T) => number | null | undefined) {
  return (a: T, b: T): number => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  };
}
