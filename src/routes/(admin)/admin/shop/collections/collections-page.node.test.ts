import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards the Collections admin page against regressing to a placeholder.
 *
 * This page shipped as a stub reading "Collections ship alongside the
 * product catalog in v3.1" — and was still saying that at v3.8.1, seven
 * minor versions later, while the backend (3 tables, service methods and
 * a live public API) had been complete the whole time.
 *
 * A version-numbered "coming soon" string is the specific thing worth
 * asserting against: it ages silently, and nothing else in the codebase
 * fails when it does.
 */
const PAGE = new URL("./+page.svelte", import.meta.url).pathname;
const SERVER = new URL("./+page.server.ts", import.meta.url).pathname;
// The table markup moved into the shared admin DataTable, so the
// horizontal-scroll guarantee is now asserted where it actually lives.
const DATA_TABLE = new URL(
  "../../../../../lib/components/admin/DataTable.svelte",
  import.meta.url,
).pathname;

describe("collections admin page", () => {
  const page = readFileSync(PAGE, "utf8");
  const server = readFileSync(SERVER, "utf8");
  const dataTable = readFileSync(DATA_TABLE, "utf8");

  it("makes no 'ships in vX.Y' promise", () => {
    // The exact failure mode: a future-tense version claim that nobody
    // revisits once that version ships.
    expect(page).not.toMatch(/ship[s]? .{0,30}in v\d/i);
    expect(page).not.toMatch(/coming soon/i);
  });

  it("loads real collections rather than returning an empty object", () => {
    expect(server).toMatch(/listCollectionsForAdmin/);
    expect(server).not.toMatch(/return \{\};/);
  });

  it("can create a collection", () => {
    expect(server).toMatch(/createCollection/);
    expect(page).toMatch(/action="\?\/create"/);
  });

  it("loads products so a collection can be populated at creation", () => {
    // Creating only-empty collections is the less useful half; without
    // products in the loader the form cannot offer them.
    expect(server).toMatch(/listProducts/);
    expect(page).toMatch(/name="productIds"/);
  });

  it("requires the English title, since the slug derives from it", () => {
    expect(server).toMatch(/English title is required/);
  });

  it("keeps the table horizontally scrollable on mobile", () => {
    // overflow-hidden clips rather than scrolls — the bug fixed across
    // 13 admin tables in v3.8.0. The page renders its table through
    // DataTable, so that is where the wrapper class has to be correct;
    // the page itself must not hand-roll a clipping wrapper either.
    expect(dataTable).toMatch(/overflow-x-auto/);
    expect(dataTable).not.toMatch(/overflow-hidden[^"]*">\s*<table/);
    expect(page).not.toMatch(/border-border overflow-hidden">\s*<table/);
  });
});
