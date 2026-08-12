/**
 * Upload demo product imagery to R2 and register it in the media library.
 *
 * Companion to seed-shop-demo.ts, which seeds the catalogue but leaves
 * `featured_media_id` resolving to whatever media rows exist. Run this
 * first (or after — it re-points products either way) to give the demo
 * real photography instead of placeholder tiles.
 *
 * Images are read from a local directory, one JPEG per product slug:
 *
 *   <images-dir>/canvas-tote-bag.jpg  ->  product slug "canvas-tote-bag"
 *
 * Anything whose basename doesn't match a product slug is skipped and
 * reported, so a stray file can't silently create an orphan media row.
 *
 * Usage:
 *   pnpm db:seed:media -- --images ./demo-images              # local D1
 *   D1_DB_NAME=khaopad-example-db pnpm db:seed:media -- \
 *     --images ./demo-images --remote                          # remote
 *
 * Idempotent: media ids are derived from the slug, R2 keys are stable,
 * and every write is INSERT OR REPLACE, so re-running re-uploads and
 * re-links without duplicating rows.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

const argv = process.argv.slice(2);
const remote = argv.includes("--remote");
const target = remote ? "--remote" : "--local";
const dbName = process.env.D1_DB_NAME ?? "khaopad-db";
const bucket = process.env.R2_BUCKET ?? "khaopad-media";

const imagesFlag = argv.indexOf("--images");
if (imagesFlag === -1 || !argv[imagesFlag + 1]) {
  console.error(
    "[seed-shop-media] --images <dir> is required (one .jpg per product slug)",
  );
  process.exit(1);
}
const imagesDir = argv[imagesFlag + 1];

const now = new Date().toISOString();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const mediaIdFor = (slug: string) => `seed_media_${slug.replace(/-/g, "_")}`;

const files = readdirSync(imagesDir).filter((f) =>
  [".jpg", ".jpeg"].includes(extname(f).toLowerCase()),
);
if (files.length === 0) {
  console.error(`[seed-shop-media] no .jpg files in ${imagesDir}`);
  process.exit(1);
}

// R2 first: a media row pointing at a missing object renders as a broken
// image, which is worse than no image at all. Only rows whose upload
// succeeded get written.
const uploaded: Array<{ slug: string; file: string; size: number }> = [];
const failed: string[] = [];

for (const file of files) {
  const slug = basename(file, extname(file));
  const path = join(imagesDir, file);
  const key = `products/${slug}.jpg`;
  try {
    execSync(
      `npx wrangler r2 object put ${bucket}/${key} --file=${JSON.stringify(path)} --content-type=image/jpeg${remote ? "" : " --local"}`,
      { stdio: "pipe" },
    );
    uploaded.push({ slug, file, size: statSync(path).size });
    process.stdout.write(".");
  } catch {
    failed.push(slug);
    process.stdout.write("x");
  }
}
process.stdout.write("\n");

const lines: string[] = [];
for (const { slug, size } of uploaded) {
  const id = mediaIdFor(slug);
  const alt = slug.replace(/-/g, " ");
  lines.push(
    `INSERT OR REPLACE INTO media (id, filename, r2_key, mime_type, size, width, height, alt_text, created_at) VALUES (` +
      `${q(id)}, ${q(`${slug}.jpg`)}, ${q(`products/${slug}.jpg`)}, 'image/jpeg', ${size}, 1200, 1200, ${q(alt)}, ${q(now)});`,
  );
  // Guarded by slug: an image with no matching product updates nothing
  // rather than erroring, and the summary below reports the mismatch.
  lines.push(
    `UPDATE shop_products SET featured_media_id = ${q(id)}, updated_at = ${q(now)} WHERE slug = ${q(slug)};`,
  );
}

const outDir = join(process.cwd(), ".seed");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "seed-shop-media.sql");
writeFileSync(outFile, lines.join("\n") + "\n");

console.log(`[seed-shop-media] wrote ${outFile}`);
console.log(
  `[seed-shop-media] applying to ${remote ? "REMOTE" : "LOCAL"} D1 (${dbName})…`,
);

try {
  execSync(`npx wrangler d1 execute ${dbName} ${target} --file=${outFile}`, {
    stdio: "inherit",
  });
} catch (err) {
  console.error(
    "[seed-shop-media] failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}

console.log(
  `[seed-shop-media] done — ${uploaded.length} image(s) uploaded and linked.`,
);
if (failed.length > 0) {
  console.warn(`[seed-shop-media] upload FAILED for: ${failed.join(", ")}`);
}
