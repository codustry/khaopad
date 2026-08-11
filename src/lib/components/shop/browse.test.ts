import { describe, expect, it } from "vitest";
import {
  activeFilterChips,
  buildFacets,
  emptyFilters,
  filterProducts,
  hasActiveFilters,
  paginateProducts,
  parseBrowseFilters,
  parseBrowsePage,
  parseBrowseSort,
  serializeBrowseQuery,
  sortProducts,
  withToggledValue,
  withoutChip,
  type BrowseProduct,
} from "./browse";

function product(overrides: Partial<BrowseProduct> = {}): BrowseProduct {
  return {
    id: "p1",
    slug: "p1",
    vendor: null,
    productType: null,
    featuredMediaId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    publishedAt: null,
    titles: { en: "Product" },
    priceMinSatang: 10000,
    priceMaxSatang: 10000,
    inStock: true,
    optionValues: {},
    collectionSlugs: [],
    ...overrides,
  };
}

const catalog: BrowseProduct[] = [
  product({
    id: "tee",
    slug: "tee",
    vendor: "Acme",
    productType: "Shirt",
    priceMinSatang: 19900,
    priceMaxSatang: 29900,
    publishedAt: "2026-02-01T00:00:00.000Z",
    optionValues: { Size: ["M", "L"], Color: ["Red"] },
    collectionSlugs: ["summer"],
  }),
  product({
    id: "mug",
    slug: "mug",
    vendor: "Bravo",
    productType: "Mug",
    priceMinSatang: 9900,
    priceMaxSatang: 9900,
    publishedAt: "2026-03-01T00:00:00.000Z",
    inStock: false,
    collectionSlugs: ["gifts"],
  }),
  product({
    id: "cap",
    slug: "cap",
    vendor: "Acme",
    productType: "Hat",
    priceMinSatang: 49900,
    priceMaxSatang: 49900,
    publishedAt: "2026-01-15T00:00:00.000Z",
    optionValues: { Size: ["S"] },
    collectionSlugs: ["summer", "gifts"],
  }),
];

describe("parseBrowseFilters", () => {
  it("reads every dimension from the URL", () => {
    const f = parseBrowseFilters(
      new URLSearchParams(
        "collection=summer&vendor=Acme&type=Shirt&price_min=100&price_max=300&opt.Size=M&opt.Size=L&availability=in_stock",
      ),
    );
    expect(f.collections).toEqual(["summer"]);
    expect(f.vendors).toEqual(["Acme"]);
    expect(f.productTypes).toEqual(["Shirt"]);
    expect(f.priceMinSatang).toBe(10000); // baht → satang
    expect(f.priceMaxSatang).toBe(30000);
    expect(f.options).toEqual({ Size: ["M", "L"] });
    expect(f.inStockOnly).toBe(true);
  });

  it("swaps inverted price bounds instead of zero-result trapping", () => {
    const f = parseBrowseFilters(
      new URLSearchParams("price_min=300&price_max=100"),
    );
    expect(f.priceMinSatang).toBe(10000);
    expect(f.priceMaxSatang).toBe(30000);
  });

  it("ignores junk values", () => {
    const f = parseBrowseFilters(
      new URLSearchParams("price_min=abc&price_max=-5&opt.=x"),
    );
    expect(f.priceMinSatang).toBeNull();
    expect(f.priceMaxSatang).toBeNull();
    expect(f.options).toEqual({});
    expect(hasActiveFilters(f)).toBe(false);
  });
});

describe("filterProducts — every facet dimension actually filters", () => {
  it("collection", () => {
    const f = { ...emptyFilters(), collections: ["summer"] };
    expect(filterProducts(catalog, f).map((p) => p.id)).toEqual(["tee", "cap"]);
  });

  it("vendor", () => {
    const f = { ...emptyFilters(), vendors: ["Bravo"] };
    expect(filterProducts(catalog, f).map((p) => p.id)).toEqual(["mug"]);
  });

  it("product type", () => {
    const f = { ...emptyFilters(), productTypes: ["Hat"] };
    expect(filterProducts(catalog, f).map((p) => p.id)).toEqual(["cap"]);
  });

  it("price range (overlap semantics)", () => {
    const f = {
      ...emptyFilters(),
      priceMinSatang: 15000,
      priceMaxSatang: 30000,
    };
    // tee's 199–299 range overlaps; mug (99) and cap (499) do not.
    expect(filterProducts(catalog, f).map((p) => p.id)).toEqual(["tee"]);
  });

  it("option values (OR within an option, AND across options)", () => {
    const size = { ...emptyFilters(), options: { Size: ["M", "S"] } };
    expect(filterProducts(catalog, size).map((p) => p.id)).toEqual([
      "tee",
      "cap",
    ]);
    const both = {
      ...emptyFilters(),
      options: { Size: ["M", "S"], Color: ["Red"] },
    };
    expect(filterProducts(catalog, both).map((p) => p.id)).toEqual(["tee"]);
  });

  it("availability", () => {
    const f = { ...emptyFilters(), inStockOnly: true };
    expect(filterProducts(catalog, f).map((p) => p.id)).toEqual(["tee", "cap"]);
  });

  it("dimensions compose", () => {
    const f = {
      ...emptyFilters(),
      collections: ["summer"],
      vendors: ["Acme"],
      inStockOnly: true,
      options: { Size: ["S"] },
    };
    expect(filterProducts(catalog, f).map((p) => p.id)).toEqual(["cap"]);
  });
});

describe("sortProducts", () => {
  it("newest by publishedAt desc", () => {
    expect(sortProducts(catalog, "newest").map((p) => p.id)).toEqual([
      "mug",
      "tee",
      "cap",
    ]);
  });

  it("price ascending / descending by cheapest variant", () => {
    expect(sortProducts(catalog, "price_asc").map((p) => p.id)).toEqual([
      "mug",
      "tee",
      "cap",
    ]);
    expect(sortProducts(catalog, "price_desc").map((p) => p.id)).toEqual([
      "cap",
      "tee",
      "mug",
    ]);
  });

  it("null preserves input (curated) order", () => {
    expect(sortProducts(catalog, null).map((p) => p.id)).toEqual([
      "tee",
      "mug",
      "cap",
    ]);
  });
});

describe("paginateProducts", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    product({ id: `p${i}`, slug: `p${i}` }),
  );

  it("slices 24 per page and clamps out-of-range pages", () => {
    const page1 = paginateProducts(many, 1);
    expect(page1.items).toHaveLength(24);
    expect(page1.totalPages).toBe(3);
    const page3 = paginateProducts(many, 3);
    expect(page3.items).toHaveLength(2);
    expect(paginateProducts(many, 99).page).toBe(3);
    expect(paginateProducts([], 5).page).toBe(1);
  });

  it("parseBrowsePage rejects junk", () => {
    expect(parseBrowsePage(new URLSearchParams("page=0"))).toBe(1);
    expect(parseBrowsePage(new URLSearchParams("page=abc"))).toBe(1);
    expect(parseBrowsePage(new URLSearchParams("page=7"))).toBe(7);
  });
});

describe("buildFacets", () => {
  it("counts each dimension ignoring its own selection", () => {
    const filters = { ...emptyFilters(), vendors: ["Acme"] };
    const facets = buildFacets(catalog, filters, { includeCollections: true });
    // Vendor counts ignore the vendor selection — Bravo must stay visible.
    expect(facets.vendors).toEqual([
      { value: "Acme", count: 2 },
      { value: "Bravo", count: 1 },
    ]);
    // Type counts respect the Acme selection.
    expect(facets.productTypes).toEqual([
      { value: "Hat", count: 1 },
      { value: "Shirt", count: 1 },
    ]);
    expect(facets.collections).toEqual([
      { value: "gifts", count: 1 },
      { value: "summer", count: 2 },
    ]);
  });

  it("exposes option values and price bounds", () => {
    const facets = buildFacets(catalog, emptyFilters());
    const size = facets.options.find((o) => o.name === "Size");
    expect(size?.values).toEqual([
      { value: "L", count: 1 },
      { value: "M", count: 1 },
      { value: "S", count: 1 },
    ]);
    expect(facets.priceBounds).toEqual({ minSatang: 9900, maxSatang: 49900 });
    expect(facets.inStockCount).toBe(2);
  });
});

describe("URL round-trip + chips", () => {
  it("serialize(parse(qs)) is stable and drops the page on filter change", () => {
    const qs =
      "?availability=in_stock&collection=summer&price_min=100&opt.Size=M&sort=price_asc";
    const filters = parseBrowseFilters(new URLSearchParams(qs));
    const sort = parseBrowseSort(new URLSearchParams(qs));
    const out = serializeBrowseQuery(filters, sort);
    expect(parseBrowseFilters(new URLSearchParams(out))).toEqual(filters);
    expect(out).not.toContain("page=");
    // Explicit pagination survives only when asked for.
    expect(serializeBrowseQuery(filters, sort, 3)).toContain("page=3");
    expect(serializeBrowseQuery(emptyFilters(), null)).toBe("");
  });

  it("withToggledValue toggles on and off immutably", () => {
    const f0 = emptyFilters();
    const f1 = withToggledValue(f0, "opt:Size", "M");
    expect(f1.options).toEqual({ Size: ["M"] });
    expect(f0.options).toEqual({});
    const f2 = withToggledValue(f1, "opt:Size", "M");
    expect(f2.options).toEqual({});
    expect(withToggledValue(f0, "stock", "").inStockOnly).toBe(true);
  });

  it("every active filter surfaces as a removable chip", () => {
    const filters = parseBrowseFilters(
      new URLSearchParams(
        "collection=summer&vendor=Acme&opt.Size=M&price_min=100&availability=in_stock",
      ),
    );
    const chips = activeFilterChips(filters);
    expect(chips).toHaveLength(5);
    // Removing every chip returns to the empty state.
    const cleared = chips.reduce((f, c) => withoutChip(f, c), filters);
    expect(hasActiveFilters(cleared)).toBe(false);
  });
});
