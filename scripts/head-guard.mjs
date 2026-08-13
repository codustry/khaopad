#!/usr/bin/env node
/**
 * <head> guard — Step 0 of the theme/engine split (#174).
 *
 * WHY THIS EXISTS
 *
 * A merge once dropped the Google Font <link>s from app.html. app.css still
 * declared the font stack, the CSP still allowed the origin, nothing threw —
 * so typecheck, lint, tests and an SSR `curl` all stayed green while the site
 * rendered in a fallback typeface. A human noticed.
 *
 * app.html is exactly the file the theme split has to touch (#174 step 4:
 * "core shell + deployment fragment"), and it has no test coverage at all.
 * This closes that specific gap: it asserts on the SSR'd <head> of real routes,
 * which needs no browser and so can run in CI today.
 *
 * SCOPE — deliberately narrow, and the limit is worth stating plainly. This
 * checks what the SERVER sends. It CANNOT see the second incident class: the
 * invisible product page, where SSR HTML was perfect and a reveal animation
 * left every element at opacity: 0 after hydration. Catching that needs a real
 * browser asserting on computed style post-hydration.
 *
 * That check is NOT included here because Playwright is not a dependency of
 * this repo, and adding a browser to CI is a decision worth making explicitly
 * rather than smuggling in with a guard script. Until it exists, hydration
 * regressions remain uncovered — so any step of the theme split that moves a
 * file with a reveal/observer animation must be verified in a browser by hand.
 * Tracked as follow-up work in #174.
 *
 * USAGE
 *   node scripts/head-guard.mjs                 # against localhost:5173
 *   node scripts/head-guard.mjs --base <url>    # against a deployment
 */
const baseIdx = process.argv.indexOf("--base");
const BASE =
  baseIdx !== -1 ? process.argv[baseIdx + 1] : "http://localhost:5173";

/** Public storefront routes — the surfaces a theme split moves. */
const ROUTES = ["/en", "/en/products", "/th"];

/**
 * Some assertions only hold for a production build. `pnpm dev` serves CSS
 * through Vite's JS injection, so there is no <link rel=stylesheet> to find.
 * Detected rather than configured, so nobody has to remember a flag.
 */
const IS_DEV = /localhost:5173|127\.0\.0\.1:5173/.test(BASE);

/**
 * Assertions against the SSR'd document. Each is something whose absence is
 * SILENT: the page still renders, still returns 200, still contains correct
 * markup, and looks wrong only to a human.
 */
const REQUIRED = [
  {
    label: "charset declaration",
    test: (html) => /<meta\s+charset=["']?utf-8/i.test(html),
    why: "Thai content mojibakes without it, and it must be in the first 1024 bytes.",
  },
  {
    label: "viewport meta",
    test: (html) => /name=["']viewport["']/i.test(html),
    why: "Mobile layout silently renders at desktop width.",
  },
  {
    label: "stylesheet link",
    // PRODUCTION ONLY. In dev, Vite injects CSS through JS and emits no
    // <link rel=stylesheet>, so asserting it there is a guaranteed false
    // positive — and a guard that cries wolf is worse than no guard, because
    // people learn to ignore it (see WooCommerce's outdated-template notice).
    test: (html) => /<link[^>]+rel=["']stylesheet["']/i.test(html),
    why: "No stylesheet link means the page renders completely unstyled.",
    productionOnly: true,
  },
  {
    label: "html lang attribute",
    test: (html) => /<html[^>]+lang=["'][a-z]{2}/i.test(html),
    why: "Screen readers and hreflang correctness depend on it.",
  },
  {
    label: "non-empty body",
    // Crude but effective: a hydration-only shell has almost no server markup.
    test: (html) =>
      (html.match(/<(div|main|section|article|h1|p)\b/gi) || []).length > 5,
    why: "A near-empty SSR body means the page depends entirely on client JS.",
  },
];

/**
 * Font <link>s are the specific thing that went missing. Upstream currently
 * self-hosts fonts via @fontsource, so an external <link> is NOT required
 * here — but a deployment that adds one (as BACtrack did) must be able to
 * assert on it. Set REQUIRED_FONT_HREF to enforce.
 */
const REQUIRED_FONT_HREF = process.env.REQUIRED_FONT_HREF || null;

let failures = 0;

for (const route of ROUTES) {
  const url = `${BASE}${route}`;
  let res, html;
  try {
    res = await fetch(url, { headers: { "cache-control": "no-cache" } });
    html = await res.text();
  } catch (err) {
    console.error(`  FAIL  [${route}] fetch failed: ${err.message}`);
    failures++;
    continue;
  }

  if (!res.ok) {
    console.error(`  FAIL  [${route}] HTTP ${res.status}`);
    failures++;
    continue;
  }

  const head = html.slice(0, html.indexOf("</head>") + 7);
  let routeFailed = false;

  for (const { label, test, why, productionOnly } of REQUIRED) {
    if (productionOnly && IS_DEV) continue;
    const target = label === "non-empty body" ? html : head;
    if (!test(target)) {
      console.error(`  FAIL  [${route}] missing ${label} — ${why}`);
      failures++;
      routeFailed = true;
    }
  }

  if (REQUIRED_FONT_HREF && !head.includes(REQUIRED_FONT_HREF)) {
    console.error(
      `  FAIL  [${route}] required font link not found: ${REQUIRED_FONT_HREF}`,
    );
    failures++;
    routeFailed = true;
  }

  if (!routeFailed) {
    const bytes = Buffer.byteLength(html);
    console.log(`  ok    [${route}] ${bytes} bytes, head ${head.length} bytes`);
  }
}

if (failures > 0) {
  console.error(
    `\n[head-guard] ${failures} failure(s).\n\n` +
      `  These are the checks that stay green in every other tool while the\n` +
      `  page renders wrong. If a change here is intentional, update this\n` +
      `  script in the same commit so the decision is reviewable.\n`,
  );
  process.exit(1);
}

console.log(`\n[head-guard] OK — ${ROUTES.length} route(s) verified.`);
