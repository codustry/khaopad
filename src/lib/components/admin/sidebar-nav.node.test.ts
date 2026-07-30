import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Regression guard for the outage that took the demo down on EVERY route
 * with a Worker 1101:
 *
 *   TypeError: Cannot read properties of undefined (reading 'get')
 *       at registerNavGroup (sidebar-nav.js)
 *
 * ## The bug
 *
 * `sidebar-nav.ts` imports `$lib/plugins/registrations` at the bottom as
 * a side effect, so plugin `registerNavGroup()` calls execute during that
 * module's OWN evaluation. The registry was a top-level
 * `const registry = new Map()`, and the bundler hoisted those calls above
 * it.
 *
 * ## Why this asserts on SOURCE rather than importing the module
 *
 * Two reasons, both honest limitations rather than convenience:
 *
 * 1. Importing it pulls in `lucide-svelte`, which needs Svelte-aware
 *    resolution. Adding that plugin would drag SvelteKit build context
 *    into unit tests for no gain.
 * 2. More importantly, importing would NOT reproduce the bug. Vitest's
 *    esbuild pipeline orders modules differently from the production
 *    Rollup build — which is precisely why `check`, `build` AND a green
 *    deploy all missed it.
 *
 * So the durable guard is structural: assert the registry is never
 * eagerly constructed at module scope. That property is what makes
 * evaluation order irrelevant.
 */
const SOURCE = new URL("./sidebar-nav.ts", import.meta.url).pathname;

describe("sidebar-nav module initialization", () => {
  const source: string = readFileSync(SOURCE, "utf8");

  it("does not construct the registry at module scope", () => {
    // This exact shape is what broke: any plugin registration hoisted
    // above it throws.
    expect(source).not.toMatch(/^const registry\s*=\s*new Map/m);
  });

  it("reads the registry through an accessor so order cannot matter", () => {
    expect(source).toMatch(/function registry\(\)/);
    expect(source).toMatch(/if \(!_registry\)/);
  });

  it("routes every registry access through the accessor", () => {
    // A single missed call site reintroduces the crash for one path only,
    // which is worse than the original because it fails conditionally.
    const offenders: string[] = source
      .split("\n")
      .map((line: string, i: number): string =>
        /\bregistry\.(get|set|entries|has|delete)\b/.test(line) &&
        !line.includes("registry().")
          ? `${i + 1}: ${line.trim()}`
          : "",
      )
      .filter((s: string): boolean => s !== "");
    expect(offenders).toEqual([]);
  });

  it("still imports plugin registrations as a side effect", () => {
    // That import is what makes ordering fragile. If it is ever removed,
    // these guards become dead weight and should be reconsidered rather
    // than left as cargo cult.
    expect(source).toMatch(/import ["']\$lib\/plugins\/registrations["']/);
  });
});
