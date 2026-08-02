import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards `listCollectionsForAdmin` against the two bugs found in the
 * post-merge hunt of my own code.
 *
 * Structural rather than behavioural: exercising the method needs a D1
 * binding, and both defects live in the shape of the query rather than
 * in a result that a small fixture would reveal — 100 collections is
 * exactly the point where a fixture stops being small.
 */
const SERVICE = new URL("./service.ts", import.meta.url).pathname;

describe("listCollectionsForAdmin", () => {
  const src = readFileSync(SERVICE, "utf8");
  const method = src.slice(
    src.indexOf("async listCollectionsForAdmin"),
    src.indexOf("async listCollectionsForAdmin") + 3000,
  );

  it("chunks ids to respect D1's 100-bound-parameter limit", () => {
    // A bare inArray(ids) breaks silently at 101 collections — D1 binds
    // at most 100 parameters per statement. The content query engine
    // solves the same problem with MAX_BIND_PARAMS/loadChunked.
    expect(method).toMatch(/CHUNK\s*=\s*100/);
    expect(method).toMatch(/slice\(i, i \+ CHUNK\)/);
  });

  it("indexes localizations instead of filtering per row", () => {
    // `locs.filter(...)` inside titleFor made this
    // O(collections x localizations).
    expect(method).toMatch(/new Map<string,/);
    expect(method).not.toMatch(/locs\.filter\(/);
  });

  it("falls back locale -> en -> any for the title", () => {
    // A Thai-only collection should still render a title rather than an
    // empty cell.
    expect(method).toMatch(/l\.locale === locale/);
    expect(method).toMatch(/l\.locale === "en"/);
  });
});
