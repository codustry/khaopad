/**
 * Storefront browse logic — pure functions, no D1, no Svelte.
 *
 * Everything filter-shaped on /products and /collections/[slug] runs
 * through this module: URL query parsing, facet filtering, sorting,
 * pagination, and URL re-serialization. Extracted so the whole facet
 * pipeline is unit-testable without a database (see browse.test.ts)
 * and so both loaders apply identical semantics.
 *
 * ## Facet dimensions (what actually filters, issue #160 A4)
 *
 * Products do NOT carry spec attribute values — the attributes system
 * (`$lib/server/content/attributes`) supports entityType "shop_product"
 * / "shop_variant" in principle, but nothing in the shop plugin ever
 * writes them (only registry "entry" rows do). So the facet UI here is
 * built over what products actually have:
 *
 *   - collection membership   (?collection=<slug>, index page only)
 *   - price range             (?price_min= / ?price_max=, in baht)
 *   - option values           (?opt.Size=M — repeatable per value)
 *   - vendor                  (?vendor=)
 *   - product type            (?type=)
 *   - availability            (?availability=in_stock)
 *
 * When products start carrying spec values, spec-attribute facets plug
 * in as additional dimensions here (parse → filter → facet counts) and
 * can lean on AttributeService.facet() for the value lookup — the URL
 * and chip plumbing below is dimension-agnostic.
 *
 * Every dimension parsed here is applied in `filterProducts` — no
 * rendered filter is decorative.
 */

export const BROWSE_PAGE_SIZE = 24;

export type BrowseSort = "newest" | "price_asc" | "price_desc";

export type BrowseProduct = {
  id: string;
  slug: string;
  vendor: string | null;
  productType: string | null;
  featuredMediaId: string | null;
  createdAt: string;
  publishedAt: string | null;
  /** locale → title (English fallback resolved at render time). */
  titles: Record<string, string>;
  /** Cheapest / dearest active-variant price. Null = no active variant. */
  priceMinSatang: number | null;
  priceMaxSatang: number | null;
  inStock: boolean;
  /** Option name → distinct values used by active variants ("Size" → ["M","L"]). */
  optionValues: Record<string, string[]>;
  /** Active collection slugs this product belongs to (index scope). */
  collectionSlugs: string[];
};

export type BrowseFilters = {
  collections: string[];
  vendors: string[];
  productTypes: string[];
  /** Stored in satang; serialized to/from whole baht in the URL. */
  priceMinSatang: number | null;
  priceMaxSatang: number | null;
  /** Option name → selected values. */
  options: Record<string, string[]>;
  inStockOnly: boolean;
};

/** A facet dimension identifier, used to ignore "own" dimension when counting. */
export type FacetDimension =
  | "collection"
  | "vendor"
  | "type"
  | "price"
  | "stock"
  | `opt:${string}`;

const OPTION_PARAM_PREFIX = "opt.";

// ─── Parsing ────────────────────────────────────────────────

export function emptyFilters(): BrowseFilters {
  return {
    collections: [],
    vendors: [],
    productTypes: [],
    priceMinSatang: null,
    priceMaxSatang: null,
    options: {},
    inStockOnly: false,
  };
}

function parseBaht(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

/** Read every filter dimension out of the URL query. */
export function parseBrowseFilters(params: URLSearchParams): BrowseFilters {
  const options: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) {
    if (!key.startsWith(OPTION_PARAM_PREFIX)) continue;
    const name = key.slice(OPTION_PARAM_PREFIX.length).trim();
    if (!name) continue;
    const values = dedupe(params.getAll(key));
    if (values.length) options[name] = values;
  }
  let priceMinSatang = parseBaht(params.get("price_min"));
  let priceMaxSatang = parseBaht(params.get("price_max"));
  if (
    priceMinSatang !== null &&
    priceMaxSatang !== null &&
    priceMinSatang > priceMaxSatang
  ) {
    // Swapped bounds are a user mistake, not a zero-result trap.
    [priceMinSatang, priceMaxSatang] = [priceMaxSatang, priceMinSatang];
  }
  return {
    collections: dedupe(params.getAll("collection")),
    vendors: dedupe(params.getAll("vendor")),
    productTypes: dedupe(params.getAll("type")),
    priceMinSatang,
    priceMaxSatang,
    options,
    inStockOnly: params.get("availability") === "in_stock",
  };
}

/** `null` = caller's default ordering (manual position on collection pages). */
export function parseBrowseSort(params: URLSearchParams): BrowseSort | null {
  const raw = params.get("sort");
  if (raw === "newest" || raw === "price_asc" || raw === "price_desc") {
    return raw;
  }
  return null;
}

export function parseBrowsePage(params: URLSearchParams): number {
  const n = Number(params.get("page") ?? "1");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function hasActiveFilters(f: BrowseFilters): boolean {
  return (
    f.collections.length > 0 ||
    f.vendors.length > 0 ||
    f.productTypes.length > 0 ||
    f.priceMinSatang !== null ||
    f.priceMaxSatang !== null ||
    Object.keys(f.options).length > 0 ||
    f.inStockOnly
  );
}

// ─── Filtering ──────────────────────────────────────────────

function matchesDimension(
  p: BrowseProduct,
  f: BrowseFilters,
  dim: FacetDimension,
): boolean {
  switch (dim) {
    case "collection":
      return (
        f.collections.length === 0 ||
        f.collections.some((slug) => p.collectionSlugs.includes(slug))
      );
    case "vendor":
      return (
        f.vendors.length === 0 ||
        (p.vendor !== null && f.vendors.includes(p.vendor))
      );
    case "type":
      return (
        f.productTypes.length === 0 ||
        (p.productType !== null && f.productTypes.includes(p.productType))
      );
    case "price": {
      if (f.priceMinSatang === null && f.priceMaxSatang === null) return true;
      if (p.priceMinSatang === null || p.priceMaxSatang === null) return false;
      // A product matches when its price RANGE overlaps the filter range —
      // "some variant of this product is in budget".
      if (f.priceMinSatang !== null && p.priceMaxSatang < f.priceMinSatang) {
        return false;
      }
      if (f.priceMaxSatang !== null && p.priceMinSatang > f.priceMaxSatang) {
        return false;
      }
      return true;
    }
    case "stock":
      return !f.inStockOnly || p.inStock;
    default: {
      // opt:<Name> — within one option the selected values OR together.
      const name = dim.slice(4);
      const selected = f.options[name] ?? [];
      if (selected.length === 0) return true;
      const values = p.optionValues[name] ?? [];
      return selected.some((v) => values.includes(v));
    }
  }
}

function allDimensions(f: BrowseFilters): FacetDimension[] {
  return [
    "collection",
    "vendor",
    "type",
    "price",
    "stock",
    ...Object.keys(f.options).map((n): FacetDimension => `opt:${n}`),
  ];
}

/**
 * Apply every filter dimension. `ignore` skips one dimension — used by
 * facet counting so a facet's own selection doesn't zero its siblings.
 */
export function filterProducts(
  products: BrowseProduct[],
  filters: BrowseFilters,
  ignore?: FacetDimension,
): BrowseProduct[] {
  const dims = allDimensions(filters).filter((d) => d !== ignore);
  return products.filter((p) =>
    dims.every((d) => matchesDimension(p, filters, d)),
  );
}

// ─── Sorting + pagination ───────────────────────────────────

export function sortProducts(
  products: BrowseProduct[],
  sort: BrowseSort | null,
): BrowseProduct[] {
  if (sort === null) return products; // caller's default ordering
  const sorted = [...products];
  switch (sort) {
    case "newest":
      sorted.sort((a, b) =>
        (b.publishedAt ?? b.createdAt).localeCompare(
          a.publishedAt ?? a.createdAt,
        ),
      );
      break;
    case "price_asc":
      sorted.sort(
        (a, b) =>
          (a.priceMinSatang ?? Infinity) - (b.priceMinSatang ?? Infinity),
      );
      break;
    case "price_desc":
      sorted.sort(
        (a, b) =>
          (b.priceMinSatang ?? -Infinity) - (a.priceMinSatang ?? -Infinity),
      );
      break;
  }
  return sorted;
}

export type BrowsePageResult = {
  items: BrowseProduct[];
  page: number;
  totalPages: number;
  total: number;
};

export function paginateProducts(
  products: BrowseProduct[],
  page: number,
  pageSize = BROWSE_PAGE_SIZE,
): BrowsePageResult {
  const total = products.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  return {
    items: products.slice((clamped - 1) * pageSize, clamped * pageSize),
    page: clamped,
    totalPages,
    total,
  };
}

// ─── Facet computation ──────────────────────────────────────

export type FacetValue = { value: string; count: number };

export type BrowseFacets = {
  collections: FacetValue[]; // value = collection slug
  vendors: FacetValue[];
  productTypes: FacetValue[];
  options: Array<{ name: string; values: FacetValue[] }>;
  inStockCount: number;
  /** Bounds over the WHOLE scope (unfiltered) — placeholder hints for the price inputs. */
  priceBounds: { minSatang: number; maxSatang: number } | null;
};

function countBy(
  products: BrowseProduct[],
  pick: (p: BrowseProduct) => string[],
): FacetValue[] {
  const counts = new Map<string, number>();
  for (const p of products) {
    for (const v of pick(p)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort(
    (a, b) => a.value.localeCompare(b.value),
  );
}

/**
 * Compute facet values + counts. Each dimension is counted against the
 * product set filtered by every OTHER dimension (standard faceted-nav
 * behavior: selecting "Size M" must not make "Size L" disappear).
 */
export function buildFacets(
  products: BrowseProduct[],
  filters: BrowseFilters,
  opts: { includeCollections?: boolean } = {},
): BrowseFacets {
  const optionNames = new Set<string>();
  for (const p of products) {
    for (const name of Object.keys(p.optionValues)) optionNames.add(name);
  }
  // Selected-but-absent option names must still be counted (their own
  // dimension ignored) so their chips/checkboxes stay removable.
  for (const name of Object.keys(filters.options)) optionNames.add(name);

  const prices = products
    .map((p) => p.priceMinSatang)
    .filter((v): v is number => v !== null);
  const maxes = products
    .map((p) => p.priceMaxSatang)
    .filter((v): v is number => v !== null);

  return {
    collections: opts.includeCollections
      ? countBy(
          filterProducts(products, filters, "collection"),
          (p) => p.collectionSlugs,
        )
      : [],
    vendors: countBy(filterProducts(products, filters, "vendor"), (p) =>
      p.vendor ? [p.vendor] : [],
    ),
    productTypes: countBy(filterProducts(products, filters, "type"), (p) =>
      p.productType ? [p.productType] : [],
    ),
    options: Array.from(optionNames)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        values: countBy(
          filterProducts(products, filters, `opt:${name}`),
          (p) => p.optionValues[name] ?? [],
        ),
      })),
    inStockCount: filterProducts(products, filters, "stock").filter(
      (p) => p.inStock,
    ).length,
    priceBounds: prices.length
      ? {
          minSatang: Math.min(...prices),
          maxSatang: Math.max(...(maxes.length ? maxes : prices)),
        }
      : null,
  };
}

// ─── URL serialization ──────────────────────────────────────

/**
 * Serialize filters + sort (+ page) back into a query string ("" when
 * everything is default). Filter/sort changes intentionally DROP the
 * page param — page 5 of an old result set is meaningless after the
 * set changes (same reset-on-filter behavior as TableToolbar).
 */
export function serializeBrowseQuery(
  filters: BrowseFilters,
  sort: BrowseSort | null,
  page = 1,
): string {
  const params = new URLSearchParams();
  for (const slug of filters.collections) params.append("collection", slug);
  for (const v of filters.vendors) params.append("vendor", v);
  for (const t of filters.productTypes) params.append("type", t);
  if (filters.priceMinSatang !== null) {
    params.set("price_min", String(filters.priceMinSatang / 100));
  }
  if (filters.priceMaxSatang !== null) {
    params.set("price_max", String(filters.priceMaxSatang / 100));
  }
  for (const [name, values] of Object.entries(filters.options)) {
    for (const v of values) params.append(`${OPTION_PARAM_PREFIX}${name}`, v);
  }
  if (filters.inStockOnly) params.set("availability", "in_stock");
  if (sort !== null) params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Immutably toggle one facet value on/off. */
export function withToggledValue(
  filters: BrowseFilters,
  dim: FacetDimension,
  value: string,
): BrowseFilters {
  const toggle = (list: string[]): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  switch (dim) {
    case "collection":
      return { ...filters, collections: toggle(filters.collections) };
    case "vendor":
      return { ...filters, vendors: toggle(filters.vendors) };
    case "type":
      return { ...filters, productTypes: toggle(filters.productTypes) };
    case "stock":
      return { ...filters, inStockOnly: !filters.inStockOnly };
    case "price":
      return { ...filters, priceMinSatang: null, priceMaxSatang: null };
    default: {
      const name = dim.slice(4);
      const next = toggle(filters.options[name] ?? []);
      const options = { ...filters.options };
      if (next.length) options[name] = next;
      else delete options[name];
      return { ...filters, options };
    }
  }
}

// ─── Active-filter chips ────────────────────────────────────

export type FilterChip = {
  dim: FacetDimension;
  /** Raw value for removal (empty for price/stock chips). */
  value: string;
  /** Display text; the price chip pre-renders its range. */
  label: string;
};

export function activeFilterChips(filters: BrowseFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const slug of filters.collections) {
    chips.push({ dim: "collection", value: slug, label: slug });
  }
  for (const v of filters.vendors) {
    chips.push({ dim: "vendor", value: v, label: v });
  }
  for (const t of filters.productTypes) {
    chips.push({ dim: "type", value: t, label: t });
  }
  for (const [name, values] of Object.entries(filters.options)) {
    for (const v of values) {
      chips.push({ dim: `opt:${name}`, value: v, label: `${name}: ${v}` });
    }
  }
  if (filters.priceMinSatang !== null || filters.priceMaxSatang !== null) {
    const min =
      filters.priceMinSatang !== null ? `฿${filters.priceMinSatang / 100}` : "";
    const max =
      filters.priceMaxSatang !== null ? `฿${filters.priceMaxSatang / 100}` : "";
    chips.push({
      dim: "price",
      value: "",
      label: min && max ? `${min}–${max}` : min ? `≥ ${min}` : `≤ ${max}`,
    });
  }
  if (filters.inStockOnly) {
    chips.push({ dim: "stock", value: "", label: "" }); // label localized in component
  }
  return chips;
}

/** Removal target for a chip — same as toggling its value off. */
export function withoutChip(
  filters: BrowseFilters,
  chip: FilterChip,
): BrowseFilters {
  return withToggledValue(filters, chip.dim, chip.value);
}

/** Resolve a product's display title for a locale (English fallback). */
export function browseTitle(p: BrowseProduct, locale: string): string {
  return p.titles[locale] ?? p.titles["en"] ?? p.slug;
}
