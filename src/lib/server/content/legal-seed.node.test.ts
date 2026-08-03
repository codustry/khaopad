import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * Guards #143: the seeded privacy policy shipped a literal
 * `/[locale]/cookie-policy` link — template syntax that was never
 * substituted, so every install's privacy policy linked to the
 * URL-encoded `/%5Blocale%5D/cookie-policy` and 404'd. It was found on
 * two independent production installs by the repo's own link crawler.
 *
 * A bad link in boilerplate is normally cosmetic; this one is the page
 * the GDPR cookie banner points at.
 */
const SEED = new URL("./legal-seed.ts", import.meta.url).pathname;
const MIGRATION = new URL(
  "../../../../drizzle/0023_fix_legal_locale_link.sql",
  import.meta.url,
).pathname;

describe("legal seed cookie-policy link", () => {
  const src = readFileSync(SEED, "utf8");

  it("templates the locale as {locale}, not the literal [locale]", () => {
    // `[locale]` looked like a placeholder but was stored verbatim.
    expect(src).not.toContain("(/[locale]/cookie-policy)");
    expect(src).toContain("(/{locale}/cookie-policy)");
  });

  it("substitutes the placeholder when building the seeded body", () => {
    expect(src).toMatch(/replace\(\s*\/\\\{locale\\\}\/g,\s*"en",?\s*\)/);
  });
});

describe("migration 0023", () => {
  it("rewrites the broken link per-locale and is idempotent", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE page_localizations (
      id TEXT PRIMARY KEY, page_id TEXT, locale TEXT, body TEXT
    );`);
    db.exec(`INSERT INTO page_localizations VALUES
      ('l1','p1','en','See the [Cookie Policy](/[locale]/cookie-policy) for details.'),
      ('l2','p1','th','ดู [Cookie Policy](/[locale]/cookie-policy) เพิ่มเติม'),
      ('l3','p2','en','No broken link here.');`);

    const sql = readFileSync(MIGRATION, "utf8");
    db.exec(sql);

    const rows = db
      .prepare("SELECT locale, body FROM page_localizations ORDER BY id")
      .all() as { locale: string; body: string }[];

    // Each row's link now carries its OWN locale.
    expect(rows[0].body).toContain("(/en/cookie-policy)");
    expect(rows[1].body).toContain("(/th/cookie-policy)");
    // Untouched rows stay byte-identical.
    expect(rows[2].body).toBe("No broken link here.");

    // Idempotent: a second run matches nothing and changes nothing.
    db.exec(sql);
    const again = db
      .prepare("SELECT body FROM page_localizations WHERE id='l1'")
      .get() as { body: string };
    expect(again.body).toBe(rows[0].body);
  });
});
