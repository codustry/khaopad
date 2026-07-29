/**
 * Money math for the shop plugin.
 *
 * Everything monetary is INTEGER satang (100 satang = 1 baht). Never
 * float — floating-point arithmetic on money is how you lose 1 satang
 * per invoice and then hunt it for a week.
 *
 * The `Satang` branded type prevents accidentally passing a raw
 * `number` (which might be baht, or bytes, or a percentage) where a
 * satang amount is expected. All shop code that handles money should
 * take/return `Satang`.
 */

// ─── Branded type ───────────────────────────────────────────

declare const satangBrand: unique symbol;

/**
 * Money amount in satang (integer). 100 satang = 1 baht.
 * `Satang` values compose with normal number arithmetic (+, -, *) but
 * cannot be mixed with a bare `number` without an explicit cast via
 * `satang()`.
 */
export type Satang = number & { readonly [satangBrand]: true };

/**
 * Assert-cast a number into satang. Throws in dev if the value is not
 * a safe integer (JS numbers lose precision past 2^53); safe integer
 * range covers ~90 trillion baht so we're comfortable.
 */
export function satang(value: number): Satang {
  if (!Number.isInteger(value)) {
    throw new Error(
      `Money value must be an integer number of satang, got ${value}`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `Money value ${value} exceeds Number.MAX_SAFE_INTEGER — use bigint if you're really selling for >90 trillion baht`,
    );
  }
  return value as Satang;
}

/** Zero satang, typed. Handy for cart totals + reduce initial values. */
export const ZERO: Satang = 0 as Satang;

// ─── Formatting ─────────────────────────────────────────────

const THAI_BAHT = new Intl.NumberFormat("th-TH", {
  style: "currency",
  currency: "THB",
  minimumFractionDigits: 2,
});

const THAI_BAHT_EN = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "THB",
  minimumFractionDigits: 2,
});

/**
 * Format satang as a Thai baht currency string.
 * `locale` chooses the numeral grouping/direction — defaults to en for
 * the admin UI, use 'th' for storefronts serving a Thai audience.
 */
export function formatSatang(
  amount: Satang,
  locale: "en" | "th" = "en",
): string {
  const baht = amount / 100;
  return (locale === "th" ? THAI_BAHT : THAI_BAHT_EN).format(baht);
}

/**
 * Parse a user-typed baht amount (e.g. "199.50") into satang.
 * Returns null on invalid input. Handles the common cases (with/
 * without a decimal point, with/without trailing zeros). Does NOT
 * handle currency symbols, thousand separators, or negative numbers —
 * shop UIs should reject those upstream.
 */
export function parseBahtToSatang(input: string): Satang | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Only digits + one optional decimal point + up to 2 decimal digits.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [wholeStr, fracStr = ""] = trimmed.split(".");
  const whole = Number(wholeStr);
  const frac = Number(fracStr.padEnd(2, "0"));
  if (Number.isNaN(whole) || Number.isNaN(frac)) return null;
  return satang(whole * 100 + frac);
}
