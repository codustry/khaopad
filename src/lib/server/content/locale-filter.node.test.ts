import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * Guards `ArticleFilter.locale`, which was declared, passed by five
 * callers, and silently ignored.
 *
 * `listArticles` destructured eight filter fields and `locale` was not
 * among them. TypeScript cannot catch that — an unread property is
 * perfectly legal — so the filter simply evaporated.
 *
 * The visible symptom: `sitemap-th.xml` advertised every published
 * article, including ones with no Thai translation. Combined with the
 * page-level fallback (`localizations[locale] ?? localizations.en`), a
 * Thai URL served English body copy — exactly the case Google names as
 * duplicate content:
 *
 *   "Localized versions of a page are only considered duplicates if the
 *    main content of the page remains untranslated."
 *   https://developers.google.com/search/docs/specialty/international/localized-versions
 *
 * Asserted against the real migration files, because the defect is in
 * the SQL shape rather than in a value a small fixture would reveal.
 */
const MIGRATIONS_DIR = new URL("../../../../drizzle", import.meta.url).pathname;

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }

  // a1 is translated into both locales; a2 is English-only.
  db.exec(`
    INSERT INTO users (id,email,name,role,created_at,updated_at) VALUES
      ('u1','a@b.c','A','admin','n','n');
    INSERT INTO articles (id,slug,status,author_id,created_at,updated_at) VALUES
      ('a1','both','published','u1','n','n'),
      ('a2','en-only','published','u1','n','n');
    INSERT INTO article_localizations (id,article_id,locale,title,body) VALUES
      ('l1','a1','en','Both EN','x'),
      ('l2','a1','th','Both TH','x'),
      ('l3','a2','en','EN only','x');
  `);
});

/** Mirrors the `inArray(articles.id, <subquery>)` condition in d1.ts. */
function idsForLocale(locale: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM articles WHERE id IN
         (SELECT article_id FROM article_localizations WHERE locale = ?)`,
    )
    .all(locale) as { id: string }[];
  return rows.map((r) => r.id).sort();
}

function allArticleIds(): string[] {
  const rows = db.prepare(`SELECT id FROM articles`).all() as { id: string }[];
  return rows.map((r) => r.id).sort();
}

describe("ArticleFilter.locale", () => {
  it("returns only articles that HAVE a Thai localization", () => {
    expect(idsForLocale("th")).toEqual(["a1"]);
  });

  it("returns both articles for English", () => {
    expect(idsForLocale("en")).toEqual(["a1", "a2"]);
  });

  it("differs from the unfiltered set — which is what leaked", () => {
    // Without the filter, every published article appeared in every
    // locale's sitemap and feed. This assertion is the regression.
    expect(allArticleIds()).toEqual(["a1", "a2"]);
    expect(idsForLocale("th")).not.toEqual(allArticleIds());
  });
});
