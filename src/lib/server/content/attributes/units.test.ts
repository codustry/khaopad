import { describe, expect, it } from "vitest";
import {
  FAMILIES,
  denormalize,
  isMeasureFamily,
  normalize,
  resolveUnit,
  UnitError,
} from "./units";

/**
 * Unit conversion is the load-bearing claim of the whole spec layer
 * (#88): faceting and comparison are only correct because every
 * measurement is normalized to one canonical number on write.
 *
 * These were previously verified by throwaway scripts that were then
 * deleted, which made the verification unrepeatable. They belong here.
 *
 * ## What these tests can and cannot prove
 *
 * They prove the conversion arithmetic and the round-trip. They do NOT
 * prove that a facet query returns the right rows — that needs real
 * SQLite and belongs in an integration suite. The comments below mark
 * where that boundary is.
 */

describe("measure families", () => {
  it("declares a standard unit that is itself a known unit", () => {
    // A standard unit absent from its own family's table would make every
    // normalize() into that family throw at runtime. resolveUnit returns
    // the canonical unit KEY (or null), not a factor.
    for (const [name, family] of Object.entries(FAMILIES)) {
      expect(
        resolveUnit(name as never, family.standardUnit),
        `${name}.standardUnit "${family.standardUnit}" is not in its own unit table`,
      ).toBe(family.standardUnit);
    }
  });

  it("normalizes a standard-unit value to itself", () => {
    // The standard unit must be an identity conversion. Any scaling here
    // would silently shift every stored value in that family.
    for (const [name, family] of Object.entries(FAMILIES)) {
      const n = normalize(name as never, 42, family.standardUnit);
      expect(n.standardValue, `${name} standard unit must be identity`).toBe(
        42,
      );
    }
  });

  it("excludes temperature", () => {
    // Deliberate: °C→K is an OFFSET, not a scale. A factor table cannot
    // express it, and including it would produce silently wrong numbers
    // rather than an error.
    expect(isMeasureFamily("temperature")).toBe(false);
  });
});

describe("normalize", () => {
  it("converts #88's own worked example: 533 g vs 0.6 kg", () => {
    // From the issue: these must compare correctly despite different
    // authored units. 0.6 kg is the heavier of the two.
    const a = normalize("mass", 533, "g").standardValue;
    const b = normalize("mass", 0.6, "kg").standardValue;
    expect(a).toBe(533);
    expect(b).toBe(600);
    expect(b).toBeGreaterThan(a);
  });

  it("converts #88's pressure example: 0.1 mbar = 10 Pa", () => {
    expect(normalize("pressure", 0.1, "mbar").standardValue).toBeCloseTo(10, 9);
  });

  it("distinguishes mbar from MPa — case matters", () => {
    // The case trap: milli- and mega- differ only by capitalization, and
    // conflating them is a factor-of-10^9 error.
    const milli = normalize("pressure", 1, "mbar").standardValue;
    const mega = normalize("pressure", 1, "MPa").standardValue;
    expect(milli).toBeCloseTo(100, 9);
    expect(mega).toBe(1_000_000);
  });

  it("preserves the authored unit for display", () => {
    // Faceting uses standardValue; the datasheet must still render what
    // the editor typed.
    expect(normalize("flow", 100, "m3/min").unit).toBe("m3/min");
  });

  it("rejects an unknown unit rather than guessing", () => {
    // Silently defaulting to factor 1 would store a wrong number that no
    // later query could detect.
    expect(() => normalize("pressure", 1, "furlongs")).toThrow(UnitError);
  });

  it("handles zero and negative values", () => {
    expect(normalize("pressure", 0, "mbar").standardValue).toBe(0);
    // Negative gauge pressure is physically meaningful; conversion must
    // not clamp it.
    expect(normalize("pressure", -1, "mbar").standardValue).toBeCloseTo(
      -100,
      9,
    );
  });
});

describe("round-trip", () => {
  it("returns the authored number for every family's non-standard units", () => {
    // This is what makes the display promise honest: a value authored as
    // "15 hp" must render as 15 hp, not 11185.5 W.
    for (const [familyName, family] of Object.entries(FAMILIES)) {
      for (const unit of Object.keys(family.units)) {
        for (const authored of [1, 0.5, 63, 12.5, 1e-3]) {
          const stored = normalize(
            familyName as never,
            authored,
            unit,
          ).standardValue;
          const back = denormalize(familyName as never, stored, unit);
          expect(
            back,
            `${familyName}: ${authored} ${unit} round-tripped to ${back}`,
          ).toBeCloseTo(authored, 6);
        }
      }
    }
  });

  it("round-trips the exact values the Phase 3 seed authors", () => {
    // Regression lock on the demo fixture's numbers, so a factor change
    // that breaks them fails here rather than on a rendered datasheet.
    const cases: [Parameters<typeof normalize>[0], number, string][] = [
      ["flow", 100, "m3/min"],
      ["pressure", 1, "Torr"],
      ["power", 15, "hp"],
      ["length", 2, "in"],
      ["mass", 12.5, "kg"],
    ];
    for (const [family, value, unit] of cases) {
      const stored = normalize(family, value, unit).standardValue;
      expect(denormalize(family, stored, unit)).toBeCloseTo(value, 9);
    }
  });
});

describe("interval comparison (#98)", () => {
  /**
   * These assert the ARITHMETIC that makes interval overlap correct
   * across mixed authored units. They do not execute SQL — the actual
   * `value_number_max >= lo AND value_number_min <= hi` predicate needs
   * real SQLite and is verified in the migration walkthrough.
   */
  it("makes a range authored in one unit comparable to a scalar in another", () => {
    // 100 m3/min = 6000 m3/h, so it must NOT overlap a 90-160 m3/h band
    // even though its authored number (100) sits inside that band. This
    // is the case that gets silently backwards without normalization.
    const authoredInMinutes = normalize("flow", 100, "m3/min").standardValue;
    const lo = normalize("flow", 90, "m3/h").standardValue;
    const hi = normalize("flow", 160, "m3/h").standardValue;
    expect(authoredInMinutes).toBe(6000);
    const overlaps = authoredInMinutes >= lo && authoredInMinutes <= hi;
    expect(overlaps).toBe(false);
  });

  it("ranks lower-is-better values correctly after normalization", () => {
    // 0.1 mbar is a BETTER vacuum than 1 Torr, but its authored number is
    // smaller — comparing authored numbers gets the ordering right here
    // by luck and wrong in general. Normalized, the relationship is
    // unambiguous.
    const mbar = normalize("pressure", 0.1, "mbar").standardValue;
    const torr = normalize("pressure", 1, "Torr").standardValue;
    expect(mbar).toBeLessThan(torr);
  });
});
