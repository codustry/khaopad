/**
 * Deployment <head> fragment injection — Step 4 of the theme/engine split
 * (#174).
 *
 * `src/app.head.html` is deployment-owned; `src/app.html` is upstream-owned.
 * This module is the join: it inlines the fragment into the marker at request
 * time via the existing `transformPageChunk` hook in hooks.server.ts.
 *
 * The mechanics were verified against @sveltejs/kit's own source
 * (core/config/index.js `load_template`, core/sync/write_server.js): the
 * template is read VERBATIM and only the four known %sveltekit.*% tokens are
 * substituted. Comments and unknown markers survive to the rendered HTML, so
 * a comment marker is a safe join point.
 *
 * (An earlier attempt concluded the opposite — that markers were stripped.
 * They were not: the verification harness was curling a port held by an
 * orphaned pre-change preview server, so every probe saw the old build. The
 * lesson is procedural, not technical: assert the server you query was
 * started by the build you are testing.)
 */
// Vite `?raw` import: the fragment is bundled at build time. That matters on
// Workers, where there is no filesystem to read at runtime. Path is relative
// to THIS file (src/lib/server/ -> src/).
import fragment from "../../app.head.html?raw";

/**
 * Marker in app.html that the fragment replaces. An HTML comment: invisible
 * if injection ever fails to run, and impossible to confuse with a
 * SvelteKit-owned %token%.
 */
export const HEAD_PLACEHOLDER =
  "<!--khaopad:head - deployment-owned fragment from src/app.head.html (#174), injected by $lib/server/app-head.ts; this whole comment is consumed at render time-->";

/**
 * The deployment's head fragment, comment-stripped.
 *
 * The upstream file is entirely explanatory comments, so stripping them keeps
 * an unmodified install's HTML free of a dead comment block. Only full
 * `<!-- ... -->` comments are removed; a deployment's real tags are untouched.
 */
export const APP_HEAD_FRAGMENT: string = fragment
  .replace(/<!--[\s\S]*?-->/g, "")
  .trim();

// Matches the marker plus its surrounding whitespace line, so an EMPTY
// fragment removes the line entirely instead of leaving a blank indented
// line in every visitor's <head>. The goal for an unmodified install is
// byte-identical output to the pre-split template, verified by diffing
// served HTML — not "close enough".
const MARKER_LINE = new RegExp(
  "[ \\t]*" + HEAD_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n?",
);

/**
 * Replace the marker in a rendered HTML chunk. Safe on every chunk: no-op
 * when the marker is absent, and the marker appears once, in <head>.
 */
export function injectAppHead(html: string): string {
  // In dev, an empty fragment is replaced by an empty COMMENT rather than
  // nothing: SvelteKit's dev server compares the "<!--" count before and
  // after transformPageChunk and prints a red "removing comments can break
  // hydration" warning on every page load when it drops. The warning is a
  // false positive here (the marker lives in <head>, not among hydration
  // markers), but a warning the team learns to ignore is worse than none —
  // that is WooCommerce's outdated-template notice in miniature. Production
  // keeps the byte-identical empty replacement; the dev/prod asymmetry is
  // confined to a comment invisible in both.
  // import.meta.env.DEV rather than $app/environment: the latter does not
  // resolve under this repo's plain-node vitest config, and Vite defines
  // DEV in dev, build and test alike.
  const empty = import.meta.env.DEV ? "    <!---->\n" : "";
  return html.replace(
    MARKER_LINE,
    APP_HEAD_FRAGMENT ? `    ${APP_HEAD_FRAGMENT}\n` : empty,
  );
}
