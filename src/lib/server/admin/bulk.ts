/**
 * Bulk-action plumbing for admin index pages (#160 C5).
 *
 * A bulk action is a loop over existing single-item service methods —
 * D1 has no cross-statement transaction to lean on anyway, so each id
 * succeeds or fails independently. The loop is chunked so a large
 * selection issues a bounded number of concurrent D1 calls instead of
 * `Promise.all` over the whole selection at once.
 */

/** Hard cap on ids per bulk request — matches the index page size. */
export const BULK_MAX_IDS = 100;

/** Concurrent service calls per chunk. */
export const BULK_CHUNK_SIZE = 20;

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: T[], size: number = BULK_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Read the repeated `ids` fields from a bulk form post. Trims,
 * drops empties, de-duplicates, preserves order. Length limits are
 * the caller's to enforce (it owns the failure response shape).
 */
export function parseBulkIds(fd: FormData): string[] {
  const seen = new Set<string>();
  for (const value of fd.getAll("ids")) {
    const id = String(value).trim();
    if (id) seen.add(id);
  }
  return [...seen];
}
