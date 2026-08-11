import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { byNumber, byString, parseSort, sortRows } from "./sort";

/**
 * #160 C5 — column sorting for admin index pages.
 *
 * The load-bearing property: the `sort` query parameter can never
 * reach SQL. It only ever selects a comparator from a literal
 * whitelist, and anything outside the whitelist is a no-op.
 */

type Row = { name: string; price: number | null; at: string };
const rows: Row[] = [
  { name: "mango", price: 300, at: "2026-02-01T00:00:00Z" },
  { name: "durian", price: null, at: "2026-01-01T00:00:00Z" },
  { name: "banana", price: 100, at: "2026-03-01T00:00:00Z" },
];
const comparators = {
  name: byString<Row>((r) => r.name),
  price: byNumber<Row>((r) => r.price),
  at: byString<Row>((r) => r.at),
};

describe("parseSort", () => {
  it("accepts only whitelisted sort keys", () => {
    const url = new URL("https://cms.example.com/admin?sort=name&dir=desc");
    expect(parseSort(url, ["name", "price"])).toEqual({
      sort: "name",
      dir: "desc",
    });
  });

  it("collapses unknown keys to null — injection attempts are no-ops", () => {
    for (const evil of [
      "createdAt; DROP TABLE shop_orders;--",
      "constructor",
      "__proto__",
      "toString",
      "1) ORDER BY (SELECT 1",
    ]) {
      const url = new URL(
        `https://cms.example.com/admin?sort=${encodeURIComponent(evil)}`,
      );
      expect(parseSort(url, ["name", "price"]).sort).toBeNull();
    }
  });

  it("collapses any dir other than desc to asc", () => {
    const url = new URL("https://cms.example.com/admin?sort=name&dir=EVIL");
    expect(parseSort(url, ["name"]).dir).toBe("asc");
  });
});

describe("sortRows", () => {
  it("sorts by a whitelisted comparator, both directions", () => {
    expect(
      sortRows(rows, comparators, "name", "asc").map((r) => r.name),
    ).toEqual(["banana", "durian", "mango"]);
    expect(
      sortRows(rows, comparators, "name", "desc").map((r) => r.name),
    ).toEqual(["mango", "durian", "banana"]);
  });

  it("puts nulls last for numeric sorts", () => {
    expect(
      sortRows(rows, comparators, "price", "asc").map((r) => r.name),
    ).toEqual(["banana", "mango", "durian"]);
  });

  it("does not mutate the input", () => {
    const before = [...rows];
    sortRows(rows, comparators, "name", "desc");
    expect(rows).toEqual(before);
  });

  it("returns rows untouched for null or non-whitelisted keys", () => {
    expect(sortRows(rows, comparators, null, "asc")).toBe(rows);
    expect(sortRows(rows, comparators, "nope", "asc")).toBe(rows);
  });

  it("cannot be tricked up the prototype chain", () => {
    // `sort=constructor` / `sort=toString` resolve to functions on
    // Object.prototype — the hasOwnProperty guard must reject them.
    expect(sortRows(rows, comparators, "constructor", "asc")).toBe(rows);
    expect(sortRows(rows, comparators, "hasOwnProperty", "asc")).toBe(rows);
  });
});

describe("index loaders use the whitelist (source pins)", () => {
  const loaders = [
    "src/routes/(admin)/admin/shop/products/+page.server.ts",
    "src/routes/(admin)/admin/shop/orders/+page.server.ts",
    "src/routes/(admin)/admin/articles/+page.server.ts",
  ];

  for (const path of loaders) {
    const src = readFileSync(
      new URL(`../../../../${path}`, import.meta.url),
      "utf8",
    );

    it(`${path} sorts via parseSort + sortRows over a literal SORTABLE whitelist`, () => {
      expect(src).toContain("parseSort(url, SORTABLE)");
      expect(src).toContain("sortRows(");
      expect(src).toMatch(/const SORTABLE = \[/);
    });

    it(`${path} never interpolates the sort param into SQL`, () => {
      // The injection-proofing is structural: the raw param may only
      // be read by parseSort, never concatenated into a query.
      expect(src).not.toMatch(/ORDER BY \$\{/i);
      expect(src).not.toMatch(/searchParams\.get\(["']sort["']\)/);
    });
  }
});
