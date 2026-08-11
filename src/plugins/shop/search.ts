/**
 * Product search — FTS5 (trigram) index maintenance + query functions.
 *
 * The index (`products_fts`, migration 0024) is a plain self-contained
 * FTS5 table over (title, description) per (product_id, locale),
 * tokenized with `trigram` so Thai text — which has no inter-word
 * spaces for unicode61 to split on — matches by substring.
 *
 * Sync model: app-level, not triggers. Every product/localization
 * write in ShopService calls `refreshProductIndex()` (delete +
 * reinsert, keyed by product_id — idempotent, drift-proof; the #48
 * contentless-trigger failure class cannot occur on a plain FTS5
 * table). Status flips need NO refresh: the index holds all statuses
 * and `searchProducts` filters `status = 'active'` at query time.
 *
 * Query-length rules (trigram tradeoff):
 *   - < MIN_QUERY_LENGTH (2): no search, empty result.
 *   - 2 chars: trigram MATCH is impossible (needs 3-codepoint
 *     windows), so fall back to a LIKE substring scan over
 *     shop_product_localizations. Fine at catalogue scale.
 *   - >= MIN_FTS_QUERY_LENGTH (3): FTS5 MATCH ranked by bm25.
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * Minimal structural view of a Drizzle database — satisfied by both
 * `drizzle-orm/d1` (Workers) and `drizzle-orm/better-sqlite3` (tests).
 */
export interface SearchDb {
  all(query: SQL): Promise<unknown[]> | unknown[];
  run(query: SQL): Promise<unknown> | unknown;
}

/** Queries shorter than this return nothing at all. */
export const MIN_QUERY_LENGTH = 2;
/** Queries shorter than this (but >= MIN_QUERY_LENGTH) use the LIKE fallback. */
export const MIN_FTS_QUERY_LENGTH = 3;

export type ProductSearchHit = {
  productId: string;
  slug: string;
  /** Title in the requested locale, falling back to the matched row's. */
  title: string;
  /** Cheapest active variant price, or null when no active variant. */
  priceFromSatang: number | null;
};

/**
 * Rebuild the index rows for ONE product: delete everything keyed to
 * `productId`, then re-insert straight from shop_product_localizations.
 * Idempotent — safe to call after create, update, or delete (after a
 * delete the re-insert SELECT simply finds no rows).
 */
export async function refreshProductIndex(
  db: SearchDb,
  productId: string,
): Promise<void> {
  await db.run(sql`DELETE FROM products_fts WHERE product_id = ${productId}`);
  await db.run(sql`
    INSERT INTO products_fts(title, description, locale, product_id)
    SELECT l.title, COALESCE(l.description_markdown, ''), l.locale, l.product_id
    FROM shop_product_localizations AS l
    WHERE l.product_id = ${productId}
  `);
}

type Row = {
  id: string;
  slug: string;
  title: string;
  price_from_satang: number | null;
};

/**
 * Search active products. Matches against ANY locale's title/
 * description (a Thai query typed on the EN storefront still finds the
 * product), de-duplicates by product, and labels each hit with the
 * requested locale's title when one exists.
 */
export async function searchProducts(
  db: SearchDb,
  opts: { query: string; locale: string; limit?: number },
): Promise<ProductSearchHit[]> {
  const trimmed = opts.query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));

  let rows: Row[];
  if (trimmed.length >= MIN_FTS_QUERY_LENGTH) {
    // Always phrase-quote: trigram has no useful operator syntax for
    // end users, and quoting defangs unbalanced punctuation that would
    // otherwise crash the FTS5 query parser.
    const ftsQuery = `"${trimmed.replace(/"/g, '""')}"`;
    // bm25() is an FTS5 auxiliary function and may only appear in the
    // FTS query itself (not inside an outer aggregate), so score in an
    // inner query and aggregate the best-per-product outside. The CTE
    // must be MATERIALIZED: without it SQLite flattens the subquery
    // into the outer join and bm25() lands back in an illegal context.
    rows = (await db.all(sql`
      WITH hit AS MATERIALIZED (
        SELECT product_id, title, bm25(products_fts) AS score
        FROM products_fts
        WHERE products_fts MATCH ${ftsQuery}
      )
      SELECT
        p.id,
        p.slug,
        COALESCE(pref.title, hit.title) AS title,
        (SELECT MIN(v.price_satang) FROM shop_product_variants AS v
          WHERE v.product_id = p.id AND v.status = 'active') AS price_from_satang,
        MIN(hit.score) AS score
      FROM hit
      JOIN shop_products AS p ON p.id = hit.product_id
      LEFT JOIN shop_product_localizations AS pref
        ON pref.product_id = p.id AND pref.locale = ${opts.locale}
      WHERE p.status = 'active'
      GROUP BY p.id
      ORDER BY score
      LIMIT ${limit}
    `)) as Row[];
  } else {
    // 2-character query — below the trigram window. LIKE substring
    // scan over titles only (descriptions would drown 2-char queries
    // in noise). `\` escape so a literal % or _ can't wildcard.
    const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    rows = (await db.all(sql`
      SELECT
        p.id,
        p.slug,
        COALESCE(pref.title, MIN(l.title)) AS title,
        (SELECT MIN(v.price_satang) FROM shop_product_variants AS v
          WHERE v.product_id = p.id AND v.status = 'active') AS price_from_satang
      FROM shop_product_localizations AS l
      JOIN shop_products AS p ON p.id = l.product_id
      LEFT JOIN shop_product_localizations AS pref
        ON pref.product_id = p.id AND pref.locale = ${opts.locale}
      WHERE l.title LIKE ${pattern} ESCAPE '\\'
        AND p.status = 'active'
      GROUP BY p.id
      ORDER BY title
      LIMIT ${limit}
    `)) as Row[];
  }

  return rows.map((r) => ({
    productId: r.id,
    slug: r.slug,
    title: r.title,
    priceFromSatang: r.price_from_satang,
  }));
}
