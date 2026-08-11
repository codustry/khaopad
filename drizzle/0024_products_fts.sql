-- Full-text search index over shop product localizations (#160 A3).
--
-- Deliberately DIFFERENT from articles_fts (0002/0011) in two ways:
--
--   1. **tokenize = 'trigram'**, not unicode61. unicode61 splits on
--      whitespace/punctuation, and Thai text has neither between words
--      — a Thai product title would index as one giant token and only
--      match on the full exact string. The trigram tokenizer (SQLite
--      >= 3.34, available on D1 and better-sqlite3) indexes every
--      3-codepoint window, so Thai substring queries work without a
--      word segmenter. Tradeoff: MATCH needs a query of >= 3
--      characters; application code (search.ts) falls back to LIKE
--      for 2-character queries and rejects shorter ones.
--
--   2. **No triggers — app-level sync.** Articles learned the hard way
--      (#48) that contentless FTS delete-triggers break on any value
--      drift. Products instead use a plain (self-contained) FTS5
--      table maintained by `refreshProductIndex()` in
--      src/plugins/shop/search.ts: DELETE ... WHERE product_id = ?
--      then re-INSERT from shop_product_localizations. A plain FTS5
--      table supports ordinary DELETE/UPDATE with WHERE, so the
--      drift-sensitive ('delete', rowid, ...) dance never applies.
--      All product localization writes flow through ShopService,
--      which calls the refresh — unlike articles, where multiple
--      code paths touch article_localizations and triggers were the
--      only reliable choke point.
--
-- Index policy: **index ALL products regardless of status** and filter
-- `shop_products.status = 'active'` at query time (JOIN in
-- searchProducts). A draft->active or active->archived flip is then a
-- plain UPDATE on shop_products with no reindex needed.
--
-- Querying (see searchProducts() in src/plugins/shop/search.ts):
--   SELECT p.id, p.slug, fts.title
--   FROM products_fts AS fts
--   JOIN shop_products AS p ON p.id = fts.product_id
--   WHERE products_fts MATCH ? AND p.status = 'active'
--   ORDER BY bm25(products_fts);

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  title,
  description,
  locale UNINDEXED,
  product_id UNINDEXED,
  tokenize = 'trigram'
);
--> statement-breakpoint

-- Backfill every existing localization row (all statuses — see index
-- policy above). Fresh installs no-op here.
INSERT INTO products_fts(title, description, locale, product_id)
SELECT l.title, COALESCE(l.description_markdown, ''), l.locale, l.product_id
FROM shop_product_localizations AS l
JOIN shop_products AS p ON p.id = l.product_id;
