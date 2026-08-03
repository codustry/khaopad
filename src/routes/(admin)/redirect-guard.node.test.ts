import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards against catching SvelteKit's redirect as an error.
 *
 * `redirect()` throws a `Redirect` object — NOT a `Response`, and not an
 * `Error`. Two create actions wrapped their success redirect in a try
 * block and guarded the catch with `err instanceof Response`, which
 * never matches. The consequence was nasty precisely because everything
 * partially worked:
 *
 *   - the article/page WAS created,
 *   - the user was told "Failed to create article",
 *   - retrying then hit the slug's UNIQUE constraint and surfaced a raw
 *     "D1_ERROR: UNIQUE constraint failed: articles.slug".
 *
 * Every layer behaved; only the guard was wrong. The correct check is
 * `isRedirect(err)` from '@sveltejs/kit'.
 *
 * This test bans the broken pattern structurally: any server file that
 * throws a redirect inside a try and re-throws from its catch must use
 * `isRedirect`, and no server file may use `err instanceof Response` as
 * a redirect guard.
 */
const ROUTES = new URL(".", import.meta.url).pathname;

function serverFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) serverFiles(full, acc);
    else if (entry.name.endsWith(".server.ts")) acc.push(full);
  }
  return acc;
}

const files = serverFiles(ROUTES);
const rel = (p: string) => p.slice(p.indexOf("(admin)"));

/** Comments stripped, so prose ABOUT the banned pattern can't trip the ban. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("redirect handling in admin actions", () => {
  it("finds server files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("never guards a redirect with `instanceof Response`", () => {
    // The broken pattern's exact signature. A structural try/catch
    // heuristic was tried first and false-positived on every file where
    // a login redirect merely coexists with an unrelated try block, and
    // on catches that correctly re-throw unconditionally — so this
    // targets the one guard that is always wrong instead.
    const offenders = files
      .filter((f) =>
        /instanceof Response/.test(stripComments(readFileSync(f, "utf8"))),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("keeps isRedirect in the two create actions that swallowed their redirect", () => {
    for (const f of ["admin/articles/new", "admin/pages/new"]) {
      const file = files.find((p) => p.includes(f + "/"));
      expect(file, f).toBeTruthy();
      const src = readFileSync(file!, "utf8");
      expect(src, f).toContain("isRedirect(err)");
      expect(src, f).toContain("throw redirect(303");
    }
  });
});
