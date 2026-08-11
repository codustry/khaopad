/**
 * Order totals engine — the ONE place order money math happens.
 * Pure functions, integer satang throughout, no I/O. (#107 #108 #112)
 *
 * ── VAT modes ───────────────────────────────────────────────
 *
 * The taxable base is the consideration actually received:
 *
 *     base = subtotal − discount + shipping
 *
 * (Thai VAT applies to shipping charged to the customer, and a
 * discount reduces the consideration — VAT is never owed on the
 * sticker price of a discounted order. #107)
 *
 * `pricesIncludeTax = false` (US-style, prices EXCLUSIVE of tax):
 *
 *     tax   = roundHalfUp(base × r / 100)          — ADDED to the total
 *     total = base + tax
 *
 * `pricesIncludeTax = true` (the Thai default, prices INCLUSIVE):
 *
 *     tax   = roundHalfUp(base × r / (100 + r))    — EXTRACTED, informational
 *     total = base                                  — sticker price stands
 *
 * ── Rounding (#112) ─────────────────────────────────────────
 *
 * ONE documented mode: round-half-up, applied ONCE, at the ORDER
 * level — the Thai Revenue Department's accepted practice for tax
 * invoices. Per-line amounts stay integer satang with no
 * intermediate rounding; the single division happens at the final
 * step via `roundHalfUpRatio` (pure integer math — no floats, so
 * no 0.49999999 artifacts, and fractional rates like 6.5% are
 * carried as scaled integers).
 *
 * Per-line rounding ("sum of rounded lines") is deliberately NOT
 * offered: it measurably drifts from round-of-sum (13 satang per
 * 1,000 lines in the #112 audit) and collapses to zero tax on
 * low-value high-quantity carts.
 *
 * ── Discount allocation (#108) ──────────────────────────────
 *
 * `allocateDiscount` distributes an order-level discount across
 * lines proportionally by line subtotal using the largest-remainder
 * (Hamilton) method, so allocations sum EXACTLY to the discount —
 * no lost or conjured satang. Tie-break is deterministic:
 * (remainder DESC, line id ASC).
 */

// ─── Integer rounding ───────────────────────────────────────

/**
 * Round-half-up division of non-negative integers: round(n / d)
 * with .5 going up. Pure integer math — no floating point.
 *
 * This is the ONLY rounding site in the totals engine.
 */
export function roundHalfUpRatio(
  numerator: number,
  denominator: number,
): number {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator <= 0
  ) {
    throw new Error(
      `roundHalfUpRatio expects non-negative integer / positive integer, got ${numerator} / ${denominator}`,
    );
  }
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  return 2 * remainder >= denominator ? quotient + 1 : quotient;
}

/**
 * Scale a percentage rate (possibly fractional, e.g. 6.5) to an
 * integer in 1/10,000ths of a percent so all downstream math is
 * integer-only. 7% → 70,000; 6.5% → 65,000.
 */
const RATE_SCALE = 10_000;
function scaleRatePct(ratePct: number): number {
  const scaled = Math.round(ratePct * RATE_SCALE);
  if (!Number.isSafeInteger(scaled) || scaled < 0) {
    throw new Error(`Invalid tax rate: ${ratePct}`);
  }
  return scaled;
}

// ─── Discount allocation (#108) ─────────────────────────────

export type AllocatableLine = {
  /** Stable line id — order item nanoid (or cart item id pre-order). */
  id: string;
  /** Line subtotal in satang (unit price × quantity), ≥ 0. */
  amountSatang: number;
};

export type DiscountAllocation = {
  id: string;
  /** Portion of the order-level discount carried by this line. */
  discountAllocatedSatang: number;
};

/**
 * Allocate an order-level discount across lines, proportionally by
 * line subtotal, largest-remainder method.
 *
 * Guarantees by construction:
 *   - Σ allocations === min(discountSatang, Σ line amounts) exactly
 *   - 0 ≤ allocation_i ≤ amount_i
 *   - |allocation_i − exact share| < 1 satang
 *   - deterministic and order-independent: tie-break is
 *     (remainder DESC, id ASC), never array position
 *
 * Edge cases: S == 0 → all zeros (no division); D ≤ 0 → all zeros;
 * D > S → clamped to S (a line total can never go negative).
 * Results are returned in the input line order.
 */
export function allocateDiscount(
  lines: AllocatableLine[],
  discountSatang: number,
): DiscountAllocation[] {
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountSatang) || line.amountSatang < 0) {
      throw new Error(
        `Line ${line.id} has invalid amountSatang: ${line.amountSatang}`,
      );
    }
  }
  if (!Number.isSafeInteger(discountSatang)) {
    throw new Error(`Invalid discountSatang: ${discountSatang}`);
  }

  const totalSatang = lines.reduce((sum, l) => sum + l.amountSatang, 0);
  const discount = Math.min(Math.max(discountSatang, 0), totalSatang);
  if (discount === 0 || totalSatang === 0) {
    return lines.map((l) => ({ id: l.id, discountAllocatedSatang: 0 }));
  }

  // floor_i = ⌊D·a_i / S⌋, rem_i = (D·a_i) mod S — all integer.
  const shares = lines.map((line) => {
    const product = discount * line.amountSatang;
    if (!Number.isSafeInteger(product)) {
      throw new Error(
        `Allocation overflow: discount ${discount} × line ${line.amountSatang}`,
      );
    }
    return {
      id: line.id,
      floor: Math.floor(product / totalSatang),
      remainder: product % totalSatang,
    };
  });

  // Distribute the residual R = D − Σ floor_i, one satang each, to
  // the R lines with the largest remainder. Deterministic tie-break
  // on id — equal-priced lines are the COMMON case in real carts.
  let residual = discount - shares.reduce((sum, s) => sum + s.floor, 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : 1),
  );
  const bonus = new Set<string>();
  for (const share of byRemainder) {
    if (residual <= 0) break;
    bonus.add(share.id);
    residual--;
  }

  return shares.map((s) => ({
    id: s.id,
    discountAllocatedSatang: s.floor + (bonus.has(s.id) ? 1 : 0),
  }));
}

// ─── Totals (#107 #112) ─────────────────────────────────────

export type TaxConfig = {
  /** False → taxSatang is always 0 (store hasn't enabled tax). */
  enabled: boolean;
  /** Percent, may be fractional (7, 6.5). */
  ratePct: number;
  /** True (Thai default): sticker prices already include VAT. */
  pricesIncludeTax: boolean;
};

export type TotalsInput = {
  lines: AllocatableLine[];
  shippingSatang: number;
  /** Order-level discount as validated by discount-service. */
  discountSatang: number;
  /**
   * True for `kind='free_shipping'` codes: the discount pays for the
   * shipping line, so NOTHING is allocated to goods lines (#108 —
   * otherwise a free-shipping order would under-refund its goods).
   * The taxable base is unaffected either way.
   */
  discountIsFreeShipping?: boolean;
  tax: TaxConfig;
};

export type OrderTotals = {
  /** Σ line subtotals (sticker, pre-discount). */
  subtotalSatang: number;
  shippingSatang: number;
  /** Effective discount, clamped to subtotal + shipping. */
  discountSatang: number;
  /**
   * VAT to ADD on top (prices-exclusive mode). 0 when
   * pricesIncludeTax or tax disabled. This is the value persisted
   * in shop_orders.tax_satang — the order total formula is
   * subtotal + shipping + tax − discount.
   */
  taxSatang: number;
  /**
   * VAT already contained in the total (prices-inclusive mode),
   * broken out for the receipt / tax invoice. 0 in exclusive mode.
   * Informational — NOT added to the total.
   */
  taxIncludedSatang: number;
  /** What the customer pays. */
  totalSatang: number;
  /**
   * #108: per-line allocation of the goods discount (discount minus
   * any part exceeding the goods subtotal, e.g. free-shipping codes).
   * Σ allocations === min(discount, subtotal) exactly.
   */
  allocations: DiscountAllocation[];
};

/**
 * Compute order totals. Single rounding point (order-level VAT,
 * half-up); everything else is exact integer arithmetic, so
 * subtotal + shipping + taxSatang − discount === total always
 * holds exactly (property-tested).
 */
export function computeTotals(input: TotalsInput): OrderTotals {
  const { lines, tax } = input;
  if (!Number.isSafeInteger(input.shippingSatang) || input.shippingSatang < 0) {
    throw new Error(`Invalid shippingSatang: ${input.shippingSatang}`);
  }

  const subtotalSatang = lines.reduce((sum, l) => sum + l.amountSatang, 0);
  const shippingSatang = input.shippingSatang;
  // Clamp: a discount can cover goods + shipping but never turn the
  // order negative (free-shipping codes discount exactly shipping;
  // a misconfigured 200% code must not go below zero).
  const discountSatang = Math.min(
    Math.max(input.discountSatang, 0),
    subtotalSatang + shippingSatang,
  );

  // #107: the taxable base is the consideration actually received.
  const baseSatang = subtotalSatang + shippingSatang - discountSatang;

  let taxSatang = 0;
  let taxIncludedSatang = 0;
  if (tax.enabled && tax.ratePct > 0 && baseSatang > 0) {
    const rate = scaleRatePct(tax.ratePct);
    if (tax.pricesIncludeTax) {
      // Extract VAT from the gross: base × r / (100 + r), with r
      // carried at RATE_SCALE: base × rS / (100·RATE_SCALE + rS).
      taxIncludedSatang = roundHalfUpRatio(
        baseSatang * rate,
        100 * RATE_SCALE + rate,
      );
    } else {
      // Add VAT on top: base × r / 100 → base × rS / (100·RATE_SCALE).
      taxSatang = roundHalfUpRatio(baseSatang * rate, 100 * RATE_SCALE);
    }
  }

  const totalSatang = baseSatang + taxSatang;

  // Allocate only the goods portion of the discount across lines —
  // the slice that pays for shipping (free-shipping codes) has no
  // line to live on.
  const allocations = allocateDiscount(
    lines,
    input.discountIsFreeShipping ? 0 : Math.min(discountSatang, subtotalSatang),
  );

  return {
    subtotalSatang,
    shippingSatang,
    discountSatang,
    taxSatang,
    taxIncludedSatang,
    totalSatang,
    allocations,
  };
}
