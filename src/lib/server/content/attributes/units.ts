/**
 * Measurement units + normalization — Phase 3 (#88 §C.1).
 *
 * The whole point of the attribute layer is that specs are *comparable*.
 * That only works if every measurement of the same kind is stored against
 * one canonical number: Akeneo's "standard unit" pattern. Author "533 g"
 * or "0.6 kg" and both land as grams, so `ORDER BY value_number` and
 * `value_number BETWEEN ?` are correct regardless of what the editor
 * typed.
 *
 * ## Why a table rather than a library
 *
 * A units library (js-quantities, convert-units) would pull a dependency
 * into the Worker bundle for a fixed, small set of families we control.
 * The families here are the ones a Thailand-first equipment catalog
 * actually needs; adding one is a few lines.
 *
 * ## Why factors, not formulas
 *
 * Every unit below is a pure scale of its family's standard unit, so
 * conversion is one multiply and is exactly invertible. Temperature is
 * deliberately EXCLUDED for this reason — °C→K is an offset, not a
 * scale, and mixing offset units into a factor table silently produces
 * wrong numbers. When temperature is needed it gets its own code path.
 */

/** A family groups units that can convert between each other. */
export type MeasureFamily =
  | "length"
  | "mass"
  | "volume"
  | "pressure"
  | "power"
  | "flow"
  | "voltage"
  | "current"
  | "frequency"
  | "speed"
  | "area"
  | "time";

export interface UnitDef {
  /** Multiply an authored value by this to get the standard unit. */
  factor: number;
  /** Accepted aliases, so "m3/h" and "m³/h" are the same unit. */
  aliases?: readonly string[];
}

export interface FamilyDef {
  /** Canonical unit every value is normalized to. */
  standardUnit: string;
  units: Record<string, UnitDef>;
}

/**
 * The unit table.
 *
 * Standard units are chosen to keep typical catalog values in a range
 * that reads naturally and avoids float noise — e.g. pressure normalizes
 * to pascal (SI) rather than mbar, but the mbar factor is exact.
 */
export const FAMILIES: Record<MeasureFamily, FamilyDef> = {
  length: {
    standardUnit: "mm",
    units: {
      mm: { factor: 1, aliases: ["millimeter", "millimetre"] },
      cm: { factor: 10, aliases: ["centimeter", "centimetre"] },
      m: { factor: 1000, aliases: ["meter", "metre"] },
      km: { factor: 1_000_000, aliases: ["kilometer", "kilometre"] },
      in: { factor: 25.4, aliases: ['"', "inch", "inches"] },
      ft: { factor: 304.8, aliases: ["'", "foot", "feet"] },
    },
  },

  mass: {
    standardUnit: "g",
    units: {
      mg: { factor: 0.001, aliases: ["milligram"] },
      g: { factor: 1, aliases: ["gram", "gramme"] },
      kg: { factor: 1000, aliases: ["kilogram", "kilo"] },
      t: { factor: 1_000_000, aliases: ["tonne", "ton", "metric ton"] },
      lb: { factor: 453.59237, aliases: ["lbs", "pound", "pounds"] },
      oz: { factor: 28.349523125, aliases: ["ounce"] },
    },
  },

  volume: {
    standardUnit: "l",
    units: {
      ml: { factor: 0.001, aliases: ["milliliter", "millilitre"] },
      l: { factor: 1, aliases: ["L", "liter", "litre"] },
      m3: { factor: 1000, aliases: ["m³", "cubic meter", "cubic metre"] },
      gal: { factor: 3.785411784, aliases: ["gallon", "us gal"] },
    },
  },

  pressure: {
    standardUnit: "Pa",
    units: {
      Pa: { factor: 1, aliases: ["pascal"] },
      hPa: { factor: 100, aliases: ["hectopascal"] },
      kPa: { factor: 1000, aliases: ["kilopascal"] },
      MPa: { factor: 1_000_000, aliases: ["megapascal"] },
      // Vacuum-equipment convention: mbar and Torr are the units
      // datasheets actually print for ultimate pressure.
      mbar: { factor: 100, aliases: ["millibar"] },
      bar: { factor: 100_000 },
      Torr: { factor: 133.322368421, aliases: ["torr", "mmHg"] },
      mTorr: { factor: 0.133322368421, aliases: ["millitorr", "micron"] },
      atm: { factor: 101_325, aliases: ["atmosphere"] },
      psi: { factor: 6894.757293168, aliases: ["PSI"] },
    },
  },

  power: {
    standardUnit: "W",
    units: {
      W: { factor: 1, aliases: ["watt"] },
      kW: { factor: 1000, aliases: ["kilowatt"] },
      MW: { factor: 1_000_000, aliases: ["megawatt"] },
      hp: { factor: 745.6998715823, aliases: ["horsepower", "HP"] },
    },
  },

  flow: {
    // Pumping speed / flow rate — the headline spec for a vacuum pump.
    standardUnit: "m3/h",
    units: {
      "m3/h": {
        factor: 1,
        aliases: ["m³/h", "m3/hr", "m³/hr", "cmh", "cbm/h"],
      },
      "m3/min": { factor: 60, aliases: ["m³/min"] },
      "m3/s": { factor: 3600, aliases: ["m³/s"] },
      "l/min": { factor: 0.06, aliases: ["lpm", "L/min"] },
      "l/s": { factor: 3.6, aliases: ["lps", "L/s"] },
      cfm: { factor: 1.69901082, aliases: ["CFM", "ft3/min", "ft³/min"] },
    },
  },

  voltage: {
    standardUnit: "V",
    units: {
      mV: { factor: 0.001, aliases: ["millivolt"] },
      V: { factor: 1, aliases: ["volt"] },
      kV: { factor: 1000, aliases: ["kilovolt"] },
    },
  },

  current: {
    standardUnit: "A",
    units: {
      mA: { factor: 0.001, aliases: ["milliamp", "milliampere"] },
      A: { factor: 1, aliases: ["amp", "ampere"] },
    },
  },

  frequency: {
    standardUnit: "Hz",
    units: {
      Hz: { factor: 1, aliases: ["hertz"] },
      kHz: { factor: 1000, aliases: ["kilohertz"] },
      rpm: { factor: 1 / 60, aliases: ["RPM", "r/min"] },
    },
  },

  speed: {
    standardUnit: "m/s",
    units: {
      "m/s": { factor: 1 },
      "km/h": { factor: 1 / 3.6, aliases: ["kph", "kmh"] },
      mph: { factor: 0.44704 },
    },
  },

  area: {
    standardUnit: "m2",
    units: {
      mm2: { factor: 0.000001, aliases: ["mm²"] },
      cm2: { factor: 0.0001, aliases: ["cm²"] },
      m2: { factor: 1, aliases: ["m²", "sqm"] },
    },
  },

  time: {
    standardUnit: "s",
    units: {
      ms: { factor: 0.001, aliases: ["millisecond"] },
      s: { factor: 1, aliases: ["sec", "second"] },
      min: { factor: 60, aliases: ["minute"] },
      h: { factor: 3600, aliases: ["hr", "hour"] },
      d: { factor: 86400, aliases: ["day"] },
    },
  },
};

export const MEASURE_FAMILIES = Object.keys(FAMILIES) as MeasureFamily[];

export function isMeasureFamily(value: string): value is MeasureFamily {
  return Object.prototype.hasOwnProperty.call(FAMILIES, value);
}

/**
 * Resolve a user-typed unit within a family, tolerating aliases and
 * case. Returns the canonical key, or null if unknown.
 *
 * Matching is exact-first, then case-insensitive: `mbar` and `MPa`
 * differ only by case in a way that matters (milli- vs mega-), so a
 * case-insensitive match must never win over an exact one.
 */
export function resolveUnit(
  family: MeasureFamily,
  unit: string,
): string | null {
  const def = FAMILIES[family];
  if (!def) return null;
  const raw = unit.trim();
  if (!raw) return null;

  if (Object.prototype.hasOwnProperty.call(def.units, raw)) return raw;

  for (const [key, u] of Object.entries(def.units)) {
    if (u.aliases?.includes(raw)) return key;
  }

  // Case-insensitive fallback, checked only after every exact match
  // failed — see the note above about mbar vs MPa.
  const lower = raw.toLowerCase();
  for (const [key, u] of Object.entries(def.units)) {
    if (key.toLowerCase() === lower) return key;
    if (u.aliases?.some((a) => a.toLowerCase() === lower)) return key;
  }
  return null;
}

/** Every unit key + alias a family accepts, for error messages and UI. */
export function unitsFor(family: MeasureFamily): string[] {
  return Object.keys(FAMILIES[family]?.units ?? {});
}

export class UnitError extends Error {
  constructor(
    message: string,
    readonly code: "UNKNOWN_FAMILY" | "UNKNOWN_UNIT" | "NOT_FINITE",
  ) {
    super(message);
    this.name = "UnitError";
  }
}

/**
 * Convert an authored value into its family's standard unit.
 *
 * Returns both numbers so callers can store the canonical magnitude for
 * querying AND the authored unit for display — a datasheet must show
 * "0.1 mbar" as the editor wrote it, not "10 Pa".
 */
export function normalize(
  family: MeasureFamily,
  value: number,
  unit: string,
): {
  value: number;
  unit: string;
  standardValue: number;
  standardUnit: string;
} {
  const def = FAMILIES[family];
  if (!def) {
    throw new UnitError(`Unknown measure family "${family}"`, "UNKNOWN_FAMILY");
  }
  if (!Number.isFinite(value)) {
    throw new UnitError(
      `Measurement value must be a finite number (got ${value})`,
      "NOT_FINITE",
    );
  }
  const key = resolveUnit(family, unit);
  if (!key) {
    throw new UnitError(
      `Unknown unit "${unit}" for family "${family}". Accepted: ${unitsFor(family).join(", ")}`,
      "UNKNOWN_UNIT",
    );
  }
  const standardValue = value * def.units[key].factor;
  if (!Number.isFinite(standardValue)) {
    throw new UnitError(`Converting ${value} ${unit} overflowed`, "NOT_FINITE");
  }
  return {
    value,
    unit: key,
    standardValue,
    standardUnit: def.standardUnit,
  };
}

/**
 * Convert a canonical magnitude back into a target unit — for rendering
 * a comparison table in whatever unit the viewer prefers.
 */
export function denormalize(
  family: MeasureFamily,
  standardValue: number,
  targetUnit: string,
): number {
  const def = FAMILIES[family];
  if (!def) {
    throw new UnitError(`Unknown measure family "${family}"`, "UNKNOWN_FAMILY");
  }
  const key = resolveUnit(family, targetUnit);
  if (!key) {
    throw new UnitError(
      `Unknown unit "${targetUnit}" for family "${family}"`,
      "UNKNOWN_UNIT",
    );
  }
  return standardValue / def.units[key].factor;
}
