#!/usr/bin/env node
/**
 * CSS inventory guard — Step 0 of the theme/engine split (#174).
 *
 * WHY THIS EXISTS
 *
 * `src/app.css` is just `@import "tailwindcss"` with no config file and no
 * `@source` directive, so Tailwind 4 auto-detects which files to scan by
 * heuristic from the project root. That is fine today, and it is a trap the
 * moment storefront files move to a theme directory: classes used only in
 * moved files can silently stop being emitted.
 *
 * The build still succeeds. Typecheck, lint and tests still pass. The HTML is
 * still correct. The CSS is just smaller, and the page renders unstyled.
 *
 * That is not hypothetical. This project has already shipped two failures of
 * exactly this shape — Google Font <link>s dropped from app.html during a
 * merge, and a product page left invisible because a reveal animation's
 * observer never ran. Both times the whole pipeline stayed green and a human
 * noticed the symptom.
 *
 * So: snapshot what the build emits, and fail loudly when it shrinks.
 *
 * USAGE
 *   node scripts/css-inventory.mjs --update   # write the baseline
 *   node scripts/css-inventory.mjs            # verify against it (CI)
 *
 * The baseline is committed. A legitimate change (deleting a component,
 * refactoring markup) will fail the check once, and you re-baseline
 * deliberately in the same commit — which is the point: the shrink becomes a
 * reviewable diff instead of a silent regression.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = ".svelte-kit/output/client/_app/immutable/assets";
const BASELINE = "css-inventory.baseline.json";
const update = process.argv.includes("--update");

/**
 * Tolerance for byte-size drift. Emitted CSS moves a little with unrelated
 * work, so an exact match would cry wolf; a large drop is the signal we care
 * about. Class-name loss is checked exactly and separately below — that is the
 * precise measure, size is the coarse backstop that catches whole files
 * dropping out of the scan.
 */
const SIZE_DROP_TOLERANCE = 0.1; // 10%

function collectCss() {
  if (!existsSync(OUT_DIR)) {
    console.error(
      `[css-inventory] ${OUT_DIR} not found — run \`pnpm build\` first.`,
    );
    process.exit(2);
  }
  const files = readdirSync(OUT_DIR).filter((f) => f.endsWith(".css"));
  if (files.length === 0) {
    console.error(`[css-inventory] no .css emitted in ${OUT_DIR}.`);
    process.exit(2);
  }
  let css = "";
  let bytes = 0;
  for (const f of files.sort()) {
    const body = readFileSync(join(OUT_DIR, f), "utf8");
    css += body;
    bytes += Buffer.byteLength(body);
  }
  return { css, bytes, fileCount: files.length };
}

/**
 * Extract class selectors. Tailwind escapes special characters in generated
 * class names (`md\:flex`, `w-1\/2`, `bg-\[\#fff\]`), so unescape before
 * comparing or the inventory churns on cosmetic output changes.
 */
function extractClasses(css) {
  const found = new Set();
  const re = /\.((?:[a-zA-Z0-9_-]|\\.)+)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    found.add(m[1].replace(/\\(.)/g, "$1"));
  }
  return [...found].sort();
}

/** CSS custom properties — the design tokens a theme split puts at risk. */
function extractVars(css) {
  const found = new Set();
  const re = /(--[a-zA-Z0-9_-]+)\s*:/g;
  let m;
  while ((m = re.exec(css)) !== null) found.add(m[1]);
  return [...found].sort();
}

const { css, bytes, fileCount } = collectCss();
const classes = extractClasses(css);
const vars = extractVars(css);
const snapshot = {
  bytes,
  fileCount,
  classCount: classes.length,
  varCount: vars.length,
  classes,
  vars,
};

if (update) {
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `[css-inventory] baseline written: ${bytes} bytes, ${classes.length} classes, ${vars.length} custom properties across ${fileCount} file(s).`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(
    `[css-inventory] no ${BASELINE} — create it with: node scripts/css-inventory.mjs --update`,
  );
  process.exit(2);
}

const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const missingClasses = base.classes.filter((c) => !classes.includes(c));
const missingVars = base.vars.filter((v) => !vars.includes(v));
const addedClasses = classes.filter((c) => !base.classes.includes(c));
const shrink = (base.bytes - bytes) / base.bytes;

let failed = false;

if (missingClasses.length > 0) {
  failed = true;
  console.error(
    `\n[css-inventory] FAIL — ${missingClasses.length} class(es) present in the baseline are NO LONGER EMITTED:`,
  );
  for (const c of missingClasses.slice(0, 40)) console.error(`  . ${c}`);
  if (missingClasses.length > 40)
    console.error(`  … and ${missingClasses.length - 40} more`);
  console.error(
    `\n  This is the silent-purge failure mode: the build succeeded and the\n  markup is unchanged, but these rules are gone, so anything using them\n  renders unstyled. Most likely a source file moved outside Tailwind's\n  auto-detected scan roots.`,
  );
}

if (missingVars.length > 0) {
  failed = true;
  console.error(
    `\n[css-inventory] FAIL — ${missingVars.length} custom propert(ies) no longer emitted:`,
  );
  for (const v of missingVars.slice(0, 40)) console.error(`  ${v}`);
  console.error(
    `\n  Design tokens vanishing usually means app.css (or an @theme block)\n  stopped being included in the build.`,
  );
}

if (shrink > SIZE_DROP_TOLERANCE) {
  failed = true;
  console.error(
    `\n[css-inventory] FAIL — emitted CSS shrank ${(shrink * 100).toFixed(1)}% ` +
      `(${base.bytes} → ${bytes} bytes), beyond the ${SIZE_DROP_TOLERANCE * 100}% tolerance.`,
  );
}

if (failed) {
  console.error(
    `\n  If the loss is intentional, re-baseline in the same commit so the\n  reduction is visible in review:\n    node scripts/css-inventory.mjs --update\n`,
  );
  process.exit(1);
}

console.log(
  `[css-inventory] OK — ${classes.length} classes (+${addedClasses.length} new), ` +
    `${vars.length} custom properties, ${bytes} bytes ` +
    `(${shrink >= 0 ? "-" : "+"}${Math.abs(shrink * 100).toFixed(1)}% vs baseline).`,
);
