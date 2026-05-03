-- Fix #48: switch articles_fts from a contentless FTS5 table to an
-- external-content table (content='article_localizations',
-- content_rowid='rowid').
--
-- The contentless pattern from migration 0002 requires the
-- ('delete', old.rowid, …all column values…) tuple to **exactly
-- match** what's stored in the index. Any drift — different
-- normalization, trailing newline, prior failed REPLACE — makes the
-- delete-trigger fail with SQLITE_ERROR. UPDATE inherits that fault.
-- After-effect on the CMS: editors couldn't update or delete an
-- article_localizations row once any drift had occurred.
--
-- The external-content pattern lets the trigger reference rowid
-- alone:
--   INSERT INTO articles_fts(articles_fts, rowid) VALUES('delete', old.rowid);
-- — no column values to match against, so drift becomes a non-issue.
-- And `rebuild` can recover from any inconsistency without dropping
-- the table.
--
-- Migration steps:
--   1. Drop the old triggers (must happen before dropping the table).
--   2. Drop the old virtual table.
--   3. Recreate as external-content.
--   4. Rebuild the index from article_localizations in one shot.
--   5. Recreate triggers using the simpler delete pattern.

DROP TRIGGER IF EXISTS articles_fts_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS articles_fts_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS articles_fts_au;
--> statement-breakpoint
DROP TABLE IF EXISTS articles_fts;
--> statement-breakpoint

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,
  excerpt,
  body,
  locale UNINDEXED,
  article_id UNINDEXED,
  content = 'article_localizations',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint

-- Build the index from current state. With external-content, this
-- reads from article_localizations directly (the `content =` link
-- above tells FTS5 where to look).
INSERT INTO articles_fts(articles_fts) VALUES('rebuild');
--> statement-breakpoint

-- Triggers — simpler than before because external-content tables
-- only need rowid for delete (the source-of-truth values come from
-- the linked table itself).

CREATE TRIGGER IF NOT EXISTS articles_fts_ai AFTER INSERT ON article_localizations BEGIN
  INSERT INTO articles_fts(rowid, title, excerpt, body, locale, article_id)
  VALUES (new.rowid, new.title, COALESCE(new.excerpt, ''), new.body, new.locale, new.article_id);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS articles_fts_ad AFTER DELETE ON article_localizations BEGIN
  INSERT INTO articles_fts(articles_fts, rowid) VALUES('delete', old.rowid);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS articles_fts_au AFTER UPDATE ON article_localizations BEGIN
  INSERT INTO articles_fts(articles_fts, rowid) VALUES('delete', old.rowid);
  INSERT INTO articles_fts(rowid, title, excerpt, body, locale, article_id)
  VALUES (new.rowid, new.title, COALESCE(new.excerpt, ''), new.body, new.locale, new.article_id);
END;
