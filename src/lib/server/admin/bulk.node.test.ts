import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BULK_CHUNK_SIZE, BULK_MAX_IDS, chunk, parseBulkIds } from "./bulk";

/** #160 C5 — bulk action plumbing. */

describe("chunk", () => {
  it("splits into consecutive bounded groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single group when under the size", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("returns nothing for an empty selection", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("rejects nonsense sizes instead of looping forever", () => {
    expect(() => chunk([1], 0)).toThrow();
  });

  it("defaults to a bounded chunk size under the request cap", () => {
    expect(BULK_CHUNK_SIZE).toBeGreaterThan(0);
    expect(BULK_CHUNK_SIZE).toBeLessThanOrEqual(BULK_MAX_IDS);
    const groups = chunk(Array.from({ length: BULK_MAX_IDS }, (_, i) => i));
    for (const g of groups)
      expect(g.length).toBeLessThanOrEqual(BULK_CHUNK_SIZE);
    expect(groups.flat().length).toBe(BULK_MAX_IDS);
  });
});

describe("parseBulkIds", () => {
  it("reads repeated ids, trims, drops empties, de-dupes", () => {
    const fd = new FormData();
    for (const v of ["a", " b ", "", "a", "c"]) fd.append("ids", v);
    expect(parseBulkIds(fd)).toEqual(["a", "b", "c"]);
  });

  it("returns empty for a form without ids", () => {
    expect(parseBulkIds(new FormData())).toEqual([]);
  });
});

describe("products bulk action (source pins)", () => {
  const server = readFileSync(
    new URL(
      "../../../routes/(admin)/admin/shop/products/+page.server.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const page = readFileSync(
    new URL(
      "../../../routes/(admin)/admin/shop/products/+page.svelte",
      import.meta.url,
    ),
    "utf8",
  );

  it("loops the service methods in chunks and caps the id count", () => {
    expect(server).toMatch(/for \(const group of chunk\(ids\)\)/);
    expect(server).toContain("BULK_MAX_IDS");
    expect(server).toContain("parseBulkIds(fd)");
  });

  it("re-checks the typed-confirm count server-side for delete", () => {
    // The prompt() is UI sugar; a hand-rolled POST must meet the same
    // bar, so the action compares confirmCount to the id list length.
    expect(server).toMatch(/confirmCount !== ids\.length/);
  });

  it("keeps archive/delete admin-only and status flips editor+", () => {
    expect(server).toMatch(/op === "archive" \|\| op === "delete"/);
    expect(server).toMatch(/needsAdmin \? "admin" : "editor"/);
  });

  it("asks the admin to type the selection count before bulk delete", () => {
    expect(page).toContain("admin_bulk_delete_prompt");
    expect(page).toMatch(/typed\?\.trim\(\) !== String\(count\)/);
  });

  it("prunes the selection when rows leave the visible set", () => {
    // A selected row hidden by a filter change must not silently
    // receive bulk operations.
    expect(page).toMatch(/selected\.filter\(\(id\) => visible\.has\(id\)\)/);
  });
});

describe("orders index (source pin)", () => {
  it("documents that bulk actions were deliberately left out", () => {
    const src = readFileSync(
      new URL(
        "../../../routes/(admin)/admin/shop/orders/+page.server.ts",
        import.meta.url,
      ),
      "utf8",
    );
    // C1 made fulfillment require a per-order tracking number, so
    // there is no honest bulk write for orders. Sorting only.
    expect(src).toMatch(/No bulk actions here, deliberately/);
  });
});
