/**
 * Seed script — inserts a sample admin user and one published article into local
 * D1 via `wrangler d1 execute`.
 *
 * Usage:
 *   pnpm db:seed               # seed local D1 (default)
 *   pnpm db:seed -- --remote   # seed production D1
 *
 * This is a *minimal* seed for development and demos — it does NOT set up a
 * Better Auth password (the `accounts` row for a password credential is
 * skipped). Use the CMS sign-up flow, or add a password via `better-auth` APIs
 * once auth is wired up end-to-end.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const remote = process.argv.includes("--remote");
const target = remote ? "--remote" : "--local";
const dbName = process.env.D1_DB_NAME ?? "khaopad-db";

const now = new Date().toISOString();

// Deterministic IDs so re-seeding is idempotent-ish (INSERT OR IGNORE).
const userId = "seed_user_admin";
const articleId = "seed_article_hello";

const sql = `
-- Khao Pad seed data (safe to re-run: uses INSERT OR IGNORE).

INSERT OR IGNORE INTO users (id, name, email, email_verified, role, created_at, updated_at)
VALUES ('${userId}', 'Seed Admin', 'admin@khaopad.local', 1, 'super_admin', '${now}', '${now}');

INSERT OR IGNORE INTO articles (id, slug, author_id, status, published_at, created_at, updated_at)
VALUES ('${articleId}', 'hello-khao-pad', '${userId}', 'published', '${now}', '${now}', '${now}');

INSERT OR IGNORE INTO article_localizations (id, article_id, locale, title, excerpt, body)
VALUES
  ('${articleId}_en', '${articleId}', 'en', 'Hello from Khao Pad',
   'Your first article, served from Cloudflare D1.',
   '# Hello from Khao Pad\\n\\nWelcome to your new CMS. Edit me in the admin panel.'),
  ('${articleId}_th', '${articleId}', 'th', 'สวัสดีจาก Khao Pad',
   'บทความแรกของคุณ จาก Cloudflare D1',
   '# สวัสดีจาก Khao Pad\\n\\nยินดีต้อนรับสู่ CMS ใหม่ของคุณ แก้ไขได้ในหน้าแอดมิน');
`.trim();

const outDir = join(process.cwd(), "drizzle");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "seed.sql");
writeFileSync(outFile, sql + "\n");

console.log(`[seed] wrote ${outFile}`);
console.log(`[seed] applying to ${remote ? "REMOTE" : "LOCAL"} D1 (${dbName})…`);

try {
  execSync(
    `npx wrangler d1 execute ${dbName} ${target} --file=${outFile}`,
    { stdio: "inherit" },
  );
  console.log("[seed] done.");
} catch (err) {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
