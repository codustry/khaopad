import { describe, expect, it } from "vitest";
import {
  bundleAvailability,
  chunk,
  componentValueSatang,
  expandQuantities,
} from "./bundles";

/**
 * Pure-function coverage for the bundle math (#165). The DB-touching
 * reserve/commit/release paths and the recursion guard are pinned in
 * bundles.integration.node.test.ts against real SQLite — the rules
 * there are about atomicity, which a mock cannot demonstrate.
 */

describe("bundleAvailability", () => {
  it("is the min over components of floor(available / qty)", () => {
    // 7 soaps at 2-per-bundle → 3 bundles; 5 candles at 1 → 5.
    // The soap is the binding constraint.
    const { available, limitingComponentIds } = bundleAvailability([
      { componentVariantId: "soap", quantity: 2, available: 7 },
      { componentVariantId: "candle", quantity: 1, available: 5 },
    ]);
    expect(available).toBe(3);
    expect(limitingComponentIds).toEqual(["soap"]);
  });

  it("floors rather than rounding — a half-bundle is not sellable", () => {
    expect(
      bundleAvailability([
        { componentVariantId: "a", quantity: 3, available: 8 },
      ]).available,
    ).toBe(2);
  });

  it("is zero when ANY component is out of stock", () => {
    const { available, limitingComponentIds } = bundleAvailability([
      { componentVariantId: "plenty", quantity: 1, available: 999 },
      { componentVariantId: "gone", quantity: 1, available: 0 },
    ]);
    expect(available).toBe(0);
    expect(limitingComponentIds).toEqual(["gone"]);
  });

  it("reports every component tied at the limit", () => {
    const { limitingComponentIds } = bundleAvailability([
      { componentVariantId: "a", quantity: 1, available: 4 },
      { componentVariantId: "b", quantity: 2, available: 8 },
      { componentVariantId: "c", quantity: 1, available: 9 },
    ]);
    // a → 4, b → 4, c → 9. Both a and b bind.
    expect(limitingComponentIds.sort()).toEqual(["a", "b"]);
  });

  it("treats untracked components as imposing no ceiling", () => {
    expect(
      bundleAvailability([
        { componentVariantId: "tracked", quantity: 1, available: 6 },
        { componentVariantId: "untracked", quantity: 10, available: null },
      ]).available,
    ).toBe(6);
  });

  it("is unlimited when every component is untracked", () => {
    expect(
      bundleAvailability([
        { componentVariantId: "a", quantity: 1, available: null },
        { componentVariantId: "b", quantity: 5, available: null },
      ]).available,
    ).toBe(Infinity);
  });

  it("is NOT purchasable when the bundle has no components", () => {
    // A merchant who flipped is_bundle on but hasn't picked parts must
    // not start taking orders for an empty box. "Contains nothing"
    // reads as "cannot be sold", never "infinitely available".
    expect(bundleAvailability([]).available).toBe(0);
  });

  it("never reports negative availability", () => {
    // Oversold component (continue-selling drove available below 0
    // before the clamp upstream) must floor at 0, not go negative.
    expect(
      bundleAvailability([
        { componentVariantId: "a", quantity: 1, available: -5 },
      ]).available,
    ).toBe(0);
  });
});

describe("expandQuantities", () => {
  it("multiplies each component by the bundle quantity", () => {
    expect(
      expandQuantities(
        [
          { componentVariantId: "soap", quantity: 2 },
          { componentVariantId: "candle", quantity: 1 },
        ],
        3,
      ),
    ).toEqual([
      { variantId: "soap", quantity: 6 },
      { variantId: "candle", quantity: 3 },
    ]);
  });

  it("sums duplicate component ids into one entry", () => {
    // Two reserves against the same variant for one line could
    // half-succeed; collapsing them means one trip through the CAS.
    expect(
      expandQuantities(
        [
          { componentVariantId: "soap", quantity: 2 },
          { componentVariantId: "soap", quantity: 3 },
        ],
        2,
      ),
    ).toEqual([{ variantId: "soap", quantity: 10 }]);
  });

  it("rejects a non-positive or fractional bundle quantity", () => {
    const comps = [{ componentVariantId: "a", quantity: 1 }];
    expect(() => expandQuantities(comps, 0)).toThrow(/positive integer/);
    expect(() => expandQuantities(comps, -1)).toThrow(/positive integer/);
    expect(() => expandQuantities(comps, 1.5)).toThrow(/positive integer/);
  });
});

describe("componentValueSatang", () => {
  it("sums quantity × price in integer satang", () => {
    expect(
      componentValueSatang([
        { quantity: 2, priceSatang: 12000 },
        { quantity: 1, priceSatang: 45000 },
      ]),
    ).toBe(69000);
  });

  it("is zero for an empty component list", () => {
    expect(componentValueSatang([])).toBe(0);
  });
});

describe("chunk", () => {
  it("respects D1's bind ceiling by defaulting to 90", () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const parts = chunk(items);
    expect(parts.map((p) => p.length)).toEqual([90, 90, 20]);
    expect(parts.flat()).toEqual(items);
  });

  it("returns no chunks for an empty list", () => {
    expect(chunk([])).toEqual([]);
  });
});
