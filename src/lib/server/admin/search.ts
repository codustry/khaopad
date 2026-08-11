/**
 * ⌘K admin content search (#160 C7) — the query half.
 *
 * Pure functions over a `SearchDb` (the same minimal structural
 * interface the storefront product search uses), so the integration
 * tests can run them against better-sqlite3 with the real migration
 * chain, and the endpoint runs them against D1.
 *
 * PII rule: order hits carry the buyer email (the admin searches BY
 * email, so it must appear to disambiguate) and nothing else — no
 * addresses, no charge ids. Pinned by tests on the result key sets.
 */
import { sql } from "drizzle-orm";
import {
  MIN_FTS_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  type SearchDb,
} from "$plugins/shop/search";

export type AdminOrderHit = {
  id: string;
  orderNumber: string;
  email: string;
  status: string;
};

export type AdminProductHit = {
  id: string;
  title: string;
  slug: string;
  status: string;
};

/** Escape LIKE wildcards so a literal % or _ can't widen the match. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Orders by order-number or buyer-email PREFIX. Prefix (not
 * substring) because both lookups start from something the admin is
 * reading off a support request — "KHP-2026-…" or the start of an
 * address — and prefix LIKE stays index-friendly on the unique
 * order_number column.
 */
export async function searchAdminOrders(
  db: SearchDb,
  query: string,
  limit = 5,
): Promise<AdminOrderHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  const lim = Math.max(1, Math.min(limit, 20));
  const pattern = `${escapeLike(trimmed)}%`;
  const rows = (await db.all(sql`
    SELECT id, order_number, email, status
    FROM shop_orders
    WHERE order_number LIKE ${pattern} ESCAPE '\\'
       OR email LIKE ${pattern} ESCAPE '\\'
    ORDER BY created_at DESC
    LIMIT ${lim}
  `)) as Array<{
    id: string;
    order_number: string;
    email: string;
    status: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    email: r.email,
    status: r.status,
  }));
}

type ProductRow = {
  id: string;
  slug: string;
  status: string;
  title: string | null;
};

/**
 * Products by title (via products_fts) or slug — ALL statuses, unlike
 * the storefront's `searchProducts`, because the admin reaches for ⌘K
 * precisely to find the draft they were editing. Same query-length
 * tiers as the storefront: >= 3 chars uses the trigram FTS index,
 * 2 chars falls back to a LIKE scan (trigram needs 3-codepoint
 * windows), < 2 returns nothing.
 */
export async function searchAdminProducts(
  db: SearchDb,
  query: string,
  limit = 5,
): Promise<AdminProductHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  const lim = Math.max(1, Math.min(limit, 20));
  const pattern = `%${escapeLike(trimmed)}%`;

  let rows: ProductRow[];
  if (trimmed.length >= MIN_FTS_QUERY_LENGTH) {
    // Phrase-quote for the same reason searchProducts does: defang
    // unbalanced punctuation before it reaches the FTS5 query parser.
    const ftsQuery = `"${trimmed.replace(/"/g, '""')}"`;
    // bm25() may only appear alongside MATCH, so it is scored in the
    // MATERIALIZED CTE and aggregated outside — the pattern proven in
    // $plugins/shop/search.ts.
    rows = (await db.all(sql`
      WITH hit AS MATERIALIZED (
        SELECT product_id, bm25(products_fts) AS score
        FROM products_fts
        WHERE products_fts MATCH ${ftsQuery}
      )
      SELECT
        p.id,
        p.slug,
        p.status,
        COALESCE(en.title, (
          SELECT l.title FROM shop_product_localizations AS l
          WHERE l.product_id = p.id LIMIT 1
        )) AS title,
        MIN(hit.score) AS score
      FROM shop_products AS p
      LEFT JOIN hit ON hit.product_id = p.id
      LEFT JOIN shop_product_localizations AS en
        ON en.product_id = p.id AND en.locale = 'en'
      WHERE hit.product_id IS NOT NULL
         OR p.slug LIKE ${pattern} ESCAPE '\\'
      GROUP BY p.id
      ORDER BY (MIN(hit.score) IS NULL), MIN(hit.score), p.slug
      LIMIT ${lim}
    `)) as ProductRow[];
  } else {
    rows = (await db.all(sql`
      SELECT
        p.id,
        p.slug,
        p.status,
        COALESCE(en.title, MIN(l.title)) AS title
      FROM shop_products AS p
      LEFT JOIN shop_product_localizations AS l ON l.product_id = p.id
      LEFT JOIN shop_product_localizations AS en
        ON en.product_id = p.id AND en.locale = 'en'
      WHERE l.title LIKE ${pattern} ESCAPE '\\'
         OR p.slug LIKE ${pattern} ESCAPE '\\'
      GROUP BY p.id
      ORDER BY title
      LIMIT ${lim}
    `)) as ProductRow[];
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? r.slug,
    slug: r.slug,
    status: r.status,
  }));
}
