-- Full-text search index over article localizations.
--
-- Why this is hand-written SQL and not Drizzle codegen:
--   FTS5 virtual tables are not part of Drizzle's schema vocabulary.
--   They live alongside the base table, are kept in sync by SQLite
--   triggers, and their content is queried via MATCH (not =).
--
-- Design:
--   - Virtual table mirrors article_localizations (title, excerpt, body)
--     and carries the locale + article_id forward as unindexed columns
--     so we can JOIN back without a second query.
--   - tokenize='unicode61 remove_diacritics 2' handles Thai + Latin
--     reasonably; FTS5's default 'simple' tokenizer would be ASCII-only.
--   - Three triggers (AFTER INSERT/UPDATE/DELETE) keep the index in
--     sync with article_localizations writes — application code stays
--     ignorant of the index.
--   - The backfill at the bottom populates the index for any rows that
--     existed before this migration ran.
--
-- Querying:
--   SELECT articleId, locale, snippet(articles_fts, 2, '<b>', '</b>', '…', 24)
--   FROM articles_fts
--   WHERE articles_fts MATCH ?
--   ORDER BY rank;

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  excerpt,
  body,
  locale UNINDEXED,
  article_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS articles_fts_ai AFTER INSERT ON article_localizations BEGIN
  INSERT INTO articles_fts(rowid, title, excerpt, body, locale, article_id)
  VALUES (new.rowid, new.title, COALESCE(new.excerpt, ''), new.body, new.locale, new.article_id);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS articles_fts_ad AFTER DELETE ON article_localizations BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, excerpt, body, locale, article_id)
  VALUES('delete', old.rowid, old.title, COALESCE(old.excerpt, ''), old.body, old.locale, old.article_id);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS articles_fts_au AFTER UPDATE ON article_localizations BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, excerpt, body, locale, article_id)
  VALUES('delete', old.rowid, old.title, COALESCE(old.excerpt, ''), old.body, old.locale, old.article_id);
  INSERT INTO articles_fts(rowid, title, excerpt, body, locale, article_id)
  VALUES (new.rowid, new.title, COALESCE(new.excerpt, ''), new.body, new.locale, new.article_id);
END;
--> statement-breakpoint

-- Backfill any rows that existed before this migration.
INSERT INTO articles_fts(rowid, title, excerpt, body, locale, article_id)
SELECT rowid, title, COALESCE(excerpt, ''), body, locale, article_id
FROM article_localizations
WHERE rowid NOT IN (SELECT rowid FROM articles_fts);
