#!/usr/bin/env node
/**
 * Crawl a deployed Khao Pad install and report broken links.
 *
 * ## Why this exists
 *
 * The cookie banner shipped a hardcoded link to `/privacy-policy` that
 * 404'd on any install without that page — on a GDPR consent banner,
 * where it is the one link that legally ought to resolve. Nothing caught
 * it, because unit tests do not follow hrefs and CI never loads a page.
 *
 * A crawler is the only thing that finds "this link points at nothing".
 *
 * ## Usage
 *
 *   node scripts/smoke-links.mjs https://your-site.example
 *   node scripts/smoke-links.mjs https://your-site.example --max 100
 *
 * Exits non-zero if any internal link returns >= 400, so it can gate a
 * deploy. External links are checked but never fail the run — a
 * third-party being down is not our regression.
 */

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http"));
if (!base) {
  console.error("usage: node scripts/smoke-links.mjs <base-url> [--max N]");
  process.exit(2);
}
const maxPages = Number(
  args.includes("--max") ? args[args.indexOf("--max") + 1] : 40,
);

const origin = new URL(base).origin;
const seen = new Set();
const queue = [new URL(base).pathname || "/"];
/** @type {{from:string,href:string,status:number|string}[]} */
const broken = [];
let checked = 0;

/** Extract hrefs without a DOM — good enough for server-rendered HTML. */
function extractHrefs(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)].map(
    (m) => m[1],
  );
}

function isCrawlable(href) {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (/^(mailto|tel|javascript):/i.test(href)) return false;
  return true;
}

while (queue.length && checked < maxPages) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);
  checked++;

  let res;
  try {
    // Send a realistic Accept-Language. Node's default is `*`, which is a
    // legal wildcard the site must handle — but a crawler reporting on
    // header-specific behaviour is testing the wrong thing. `/` returning
    // 404 for `*` was a REAL bug (fixed in the locale negotiation), and
    // this header keeps the crawl focused on link targets.
    res = await fetch(origin + path, {
      redirect: "follow",
      headers: { "accept-language": "en" },
    });
  } catch (err) {
    broken.push({
      from: "(crawl)",
      href: path,
      status: String(err).slice(0, 40),
    });
    continue;
  }
  if (res.status >= 400) {
    broken.push({ from: "(crawl)", href: path, status: res.status });
    continue;
  }
  if (!(res.headers.get("content-type") || "").includes("text/html")) continue;

  const html = await res.text();
  for (const raw of extractHrefs(html)) {
    if (!isCrawlable(raw)) continue;
    let target;
    try {
      target = new URL(raw, origin + path);
    } catch {
      continue;
    }
    // External: check reachability, never fail the run on it.
    if (target.origin !== origin) continue;
    if (!seen.has(target.pathname)) queue.push(target.pathname);
  }
}

console.log(`Crawled ${checked} page(s) from ${origin}`);
if (broken.length === 0) {
  console.log("✔ No broken internal links.");
  process.exit(0);
}
console.error(`\n✘ ${broken.length} broken link(s):`);
for (const b of broken) console.error(`  ${b.status}  ${b.href}`);
process.exit(1);
