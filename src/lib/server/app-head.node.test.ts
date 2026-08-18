/**
 * Covers the app.html / app.head.html split (#174 Step 4).
 *
 * app.html had NO test coverage before this — precisely why the incident
 * behind #174 was silent: a merge dropped a fork's Google Fonts <link> tags,
 * nothing threw, and every check stayed green.
 *
 * NOTE the limits of these tests, learned the hard way: they assert SOURCE
 * files and pure functions. They cannot prove the fragment reaches the
 * SERVED page — the first Step 4 attempt had all-green tests while probing a
 * stale orphaned server. The served-output check lives in the release
 * verification (build + strictPort preview + curl), not here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { injectAppHead, APP_HEAD_FRAGMENT, HEAD_PLACEHOLDER } from "./app-head";

const root = process.cwd();
const APP_HTML = readFileSync(join(root, "src/app.html"), "utf8");
const HOOKS = readFileSync(join(root, "src/hooks.server.ts"), "utf8");

describe("app.html shell", () => {
  it("keeps the tags whose loss is silent", () => {
    expect(APP_HTML).toMatch(/<meta\s+charset=["']?utf-8/i); // Thai mojibake
    expect(APP_HTML).toMatch(/name=["']viewport["']/i); // desktop layout on mobile
    expect(APP_HTML).toMatch(/<html[^>]+lang=/i); // a11y + hreflang
    expect(APP_HTML).toContain("%sveltekit.head%"); // all SEO tags
    expect(APP_HTML).toContain("%sveltekit.body%"); // the entire app
  });

  it("carries the deployment marker after %sveltekit.head%", () => {
    expect(APP_HTML).toContain(HEAD_PLACEHOLDER);
    expect(APP_HTML.indexOf(HEAD_PLACEHOLDER)).toBeGreaterThan(
      APP_HTML.indexOf("%sveltekit.head%"),
    );
  });

  it("keeps the theme bootstrap inline and nonced", () => {
    // Must run before first paint; un-nonced inline scripts are silently
    // refused under the nonce CSP (#133).
    expect(APP_HTML).toContain("%sveltekit.nonce%");
    expect(APP_HTML).toContain("khaopad-theme");
  });
});

describe("head fragment injection", () => {
  it("replaces the marker", () => {
    const out = injectAppHead(`<head>${HEAD_PLACEHOLDER}</head>`);
    expect(out).not.toContain(HEAD_PLACEHOLDER);
  });

  it("leaves html without the marker untouched", () => {
    const html = "<p>no marker here</p>";
    expect(injectAppHead(html)).toBe(html);
  });

  it("emits nothing real for an unmodified upstream install", () => {
    // app.head.html ships as pure explanatory comments; shipping them to
    // every visitor would be noise and would dirty SSR diffs.
    expect(APP_HEAD_FRAGMENT).toBe("");
    const out = injectAppHead(`<head>${HEAD_PLACEHOLDER}</head>`);
    if (import.meta.env.DEV) {
      // Dev (which is what vitest runs as): the marker becomes an EMPTY
      // comment, not nothing — SvelteKit's dev server counts "<!--"
      // before/after transformPageChunk and warns in red on every page
      // load if the count drops. A warning the team learns to ignore is
      // worse than none. Production stays byte-identical (else branch).
      expect(out).toBe("<head>    <!---->\n</head>");
    } else {
      expect(out).toBe("<head></head>");
    }
    // Either way the marker itself must be gone.
    expect(out).not.toContain("khaopad:head");
  });

  it("is wired into EVERY transformPageChunk site", () => {
    // hooks.server.ts has two: the configuration-error early return and the
    // normal path. Wiring only one would drop the fragment on whichever
    // branch was missed — silently, and only for some requests.
    const chunkSites = HOOKS.match(/transformPageChunk:/g) ?? [];
    const injected = HOOKS.match(/injectAppHead\(/g) ?? [];
    expect(chunkSites.length).toBeGreaterThan(0);
    expect(injected.length).toBe(chunkSites.length);
  });

  it("still fills %lang% alongside the fragment", () => {
    expect(HOOKS).toMatch(/injectAppHead\(html\.replace\("%lang%"/);
  });
});
