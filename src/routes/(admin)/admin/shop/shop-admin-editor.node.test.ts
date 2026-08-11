import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * #160 C3/C6/C8 — structural pins for the shop admin editor work.
 *
 * These read source files rather than rendering components: the
 * regressions they guard (dropping the SaveBar wiring, losing the FTS
 * refresh, re-introducing hardcoded English) are all visible in the
 * source, and rendering Svelte 5 components needs a browser-ish
 * environment this test suite deliberately does not have.
 */

const here = (rel: string) =>
  new URL(rel, import.meta.url).pathname
    .replace(/%5B/g, "[")
    .replace(/%5D/g, "]");

const read = (rel: string) => readFileSync(here(rel), "utf8");

describe("product editor (C3)", () => {
  const page = read("./products/[id]/+page.svelte");
  const server = read("./products/[id]/+page.server.ts");

  it("wires SaveBar + DirtyState + guardUnsavedChanges", () => {
    expect(page).toMatch(/SaveBar/);
    expect(page).toMatch(/new DirtyState\(/);
    expect(page).toMatch(/guardUnsavedChanges\(/);
    expect(page).toMatch(/dirty\.beginSave\(\)/);
    expect(page).toMatch(/dirty\.commit\(/);
  });

  it("edits both locales, vendor/productType, and per-variant price/compare-at/SKU", () => {
    for (const name of [
      'name="title_en"',
      'name="title_th"',
      'name="description_en"',
      'name="description_th"',
      'name="vendor"',
      'name="product_type"',
    ]) {
      expect(page).toContain(name);
    }
    expect(page).toMatch(/variant_\$\{variant\.id\}_price/);
    expect(page).toMatch(/variant_\$\{variant\.id\}_compare_at/);
    expect(page).toMatch(/variant_\$\{variant\.id\}_sku/);
    // The variant inputs sit inside the DataTable next to per-row
    // inventory forms — they must associate by form id, not containment.
    expect(page).toMatch(/form="product-save-form"/);
  });

  it("the save action goes through the service write paths + audit log", () => {
    expect(server).toMatch(/save:\s*async/);
    expect(server).toMatch(/svc\.updateProduct\(/);
    expect(server).toMatch(/svc\.upsertLocalization\(/);
    expect(server).toMatch(/svc\.updateVariant\(/);
    expect(server).toMatch(/logAudit\([^)]*"product\.updated"/);
  });
});

describe("service write paths refresh the search index (A3 hazard)", () => {
  const service = readFileSync(
    new URL("../../../../plugins/shop/service.ts", import.meta.url).pathname,
    "utf8",
  );

  it("upsertLocalization calls refreshProductIndex after the localization write", () => {
    const start = service.indexOf("async upsertLocalization");
    expect(start).toBeGreaterThan(-1);
    const end = service.indexOf("async updateVariant", start);
    const method = service.slice(start, end);
    // Without this, an edited title keeps serving the STALE index entry.
    expect(method).toMatch(/refreshProductIndex\(this\.db, productId\)/);
    // And NOT swallowed best-effort like createProduct: the admin form
    // action must be able to surface the failure.
    expect(method).not.toMatch(/refreshProductIndex\([^)]*\)\.catch/);
  });
});

describe("global ⌘S (C8)", () => {
  const layout = readFileSync(
    new URL("../+layout.svelte", import.meta.url).pathname,
    "utf8",
  );
  const saveBar = readFileSync(
    new URL("../../../../lib/components/admin/SaveBar.svelte", import.meta.url)
      .pathname,
    "utf8",
  );

  it("the admin layout listens for meta/ctrl+S and preventDefaults", () => {
    expect(layout).toMatch(/svelte:window onkeydown=\{onGlobalKeydown\}/);
    expect(layout).toMatch(/metaKey \|\| event\.ctrlKey/);
    expect(layout).toMatch(/event\.preventDefault\(\)/);
    expect(layout).toMatch(/\[data-savebar-submit\]/);
  });

  it("SaveBar's primary button carries the data-savebar-submit hook", () => {
    expect(saveBar).toMatch(/data-savebar-submit/);
  });

  it("the settings page uses SaveBar + dirty guard", () => {
    const settings = readFileSync(
      new URL("../settings/+page.svelte", import.meta.url).pathname,
      "utf8",
    );
    expect(settings).toMatch(/<SaveBar /);
    expect(settings).toMatch(/guardUnsavedChanges\(/);
    // FormData-based snapshot: fields added later are tracked without
    // editing a hand-maintained list.
    expect(settings).toMatch(/new FormData\(formEl\)/);
  });
});

describe("shop admin pages speak Paraglide, not hardcoded English (C6)", () => {
  // Spot-pins: known strings that used to be hardcoded must now be gone.
  // (orders/[id] is excluded — owned by another Phase C agent.)
  const cases: Array<[string, string[]]> = [
    [
      "./products/+page.svelte",
      ["Create your first product", "No products yet.", ">New product<"],
    ],
    [
      "./products/new/+page.svelte",
      ["English (required)", "Pricing + inventory", "Create product</"],
    ],
    [
      "./products/[id]/+page.svelte",
      ["Danger zone", "Adjust inventory", "Delete this product"],
    ],
    [
      "./collections/+page.svelte",
      [
        "Group products for storefront browsing.",
        "New collection<",
        "(untitled)",
      ],
    ],
    [
      "./orders/+page.svelte",
      ["No orders yet.", 'header: "Placed"', "header: 'Placed'"],
    ],
    [
      "./discounts/+page.svelte",
      ['title="Discount codes"', "Percent off<", "No codes yet.<"],
    ],
  ];

  for (const [file, banned] of cases) {
    it(`${file} contains none of its former hardcoded strings`, () => {
      const src = read(file);
      expect(src).toMatch(/\$lib\/paraglide\/messages/);
      for (const text of banned) {
        expect(src).not.toContain(text);
      }
    });
  }
});
