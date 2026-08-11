import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  allocateDiscount,
  computeTotals,
  roundHalfUpRatio,
  type AllocatableLine,
} from "./totals";

/**
 * #111 (Phase B, B1) — pure-function suite for the totals engine.
 *
 * Golden values are computed BY HAND from the formulas documented in
 * totals.ts — never snapshotted from the implementation's output
 * (that would just freeze a bug).
 */

// ─── roundHalfUpRatio ───────────────────────────────────────

describe("roundHalfUpRatio — the single rounding site", () => {
  it("rounds exact halves UP (half-up, the documented mode)", () => {
    expect(roundHalfUpRatio(7, 2)).toBe(4); // 3.5 → 4
    expect(roundHalfUpRatio(5, 2)).toBe(3); // 2.5 → 3
    expect(roundHalfUpRatio(1, 2)).toBe(1); // 0.5 → 1
  });

  it("rounds below-half down, above-half up", () => {
    expect(roundHalfUpRatio(49, 100)).toBe(0);
    expect(roundHalfUpRatio(51, 100)).toBe(1);
    expect(roundHalfUpRatio(349, 100)).toBe(3);
    expect(roundHalfUpRatio(350, 100)).toBe(4);
  });

  it("is exact on divisible inputs", () => {
    expect(roundHalfUpRatio(0, 7)).toBe(0);
    expect(roundHalfUpRatio(2100, 100)).toBe(21);
  });

  it("rejects negatives, non-integers, and zero denominators", () => {
    expect(() => roundHalfUpRatio(-1, 2)).toThrow();
    expect(() => roundHalfUpRatio(1, 0)).toThrow();
    expect(() => roundHalfUpRatio(1.5, 2)).toThrow();
  });

  it("property: matches float round-half-up for safe inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (n, d) => {
          // Float reference: floor(n/d + 0.5) is half-up for positives.
          expect(roundHalfUpRatio(n, d)).toBe(Math.floor(n / d + 0.5));
        },
      ),
    );
  });
});

// ─── allocateDiscount (#108) ────────────────────────────────

/** Arbitrary for cart lines — deliberately includes 0-satang lines
 * and duplicated (equal-priced) amounts, the common real-cart case. */
const linesArb = fc
  .array(fc.integer({ min: 0, max: 500_000 }), { minLength: 0, maxLength: 12 })
  .map((amounts) =>
    amounts.map((amountSatang, i) => ({
      id: `line-${String(i).padStart(2, "0")}`,
      amountSatang,
    })),
  );

describe("allocateDiscount — largest-remainder allocation (#108)", () => {
  it("the issue's worked example: ฿10 across 3 × ฿100 lines, no lost satang", () => {
    // exact share = 1000/3 = 333.33…; floors 333×3 = 999, residual 1
    // goes to the lexicographically-first line (equal remainders).
    const lines = [
      { id: "a", amountSatang: 10000 },
      { id: "b", amountSatang: 10000 },
      { id: "c", amountSatang: 10000 },
    ];
    const result = allocateDiscount(lines, 1000);
    expect(result).toEqual([
      { id: "a", discountAllocatedSatang: 334 },
      { id: "b", discountAllocatedSatang: 333 },
      { id: "c", discountAllocatedSatang: 333 },
    ]);
  });

  it("Medusa's penny case: 3 × 199 satang, 20%% off (119) — sums exactly, no conjured cent", () => {
    const lines = [
      { id: "a", amountSatang: 199 },
      { id: "b", amountSatang: 199 },
      { id: "c", amountSatang: 199 },
    ];
    // 119 × 199/597 = 39.66… → floors 39, residual 2 → two lines get 40.
    const result = allocateDiscount(lines, 119);
    expect(result.map((r) => r.discountAllocatedSatang)).toEqual([40, 40, 39]);
    expect(result.reduce((s, r) => s + r.discountAllocatedSatang, 0)).toBe(119);
  });

  it("S == 0 allocates nothing and does not divide by zero", () => {
    expect(
      allocateDiscount(
        [
          { id: "a", amountSatang: 0 },
          { id: "b", amountSatang: 0 },
        ],
        500,
      ),
    ).toEqual([
      { id: "a", discountAllocatedSatang: 0 },
      { id: "b", discountAllocatedSatang: 0 },
    ]);
    expect(allocateDiscount([], 500)).toEqual([]);
  });

  it("D > S clamps to S — no line ever goes negative", () => {
    const result = allocateDiscount(
      [
        { id: "a", amountSatang: 300 },
        { id: "b", amountSatang: 700 },
      ],
      99_999,
    );
    expect(result).toEqual([
      { id: "a", discountAllocatedSatang: 300 },
      { id: "b", discountAllocatedSatang: 700 },
    ]);
  });

  it("D of exactly 1 satang lands on exactly one line, deterministically", () => {
    const lines = [
      { id: "b", amountSatang: 100 },
      { id: "a", amountSatang: 100 },
    ];
    const result = allocateDiscount(lines, 1);
    // Equal remainders → id ASC tie-break: "a" wins despite being second.
    expect(result).toEqual([
      { id: "b", discountAllocatedSatang: 0 },
      { id: "a", discountAllocatedSatang: 1 },
    ]);
  });

  it("zero-amount lines are allocated zero", () => {
    const result = allocateDiscount(
      [
        { id: "free", amountSatang: 0 },
        { id: "paid", amountSatang: 500 },
      ],
      100,
    );
    expect(result).toEqual([
      { id: "free", discountAllocatedSatang: 0 },
      { id: "paid", discountAllocatedSatang: 100 },
    ]);
  });

  it("rejects invalid inputs", () => {
    expect(() =>
      allocateDiscount([{ id: "a", amountSatang: -1 }], 10),
    ).toThrow();
    expect(() =>
      allocateDiscount([{ id: "a", amountSatang: 1.5 }], 10),
    ).toThrow();
    expect(() =>
      allocateDiscount([{ id: "a", amountSatang: 1 }], 0.5),
    ).toThrow();
  });

  // ── Properties (#111's invariant list) ──

  const discountArb = fc.integer({ min: 0, max: 2_000_000 });

  it("property: Σ allocations === min(D, S) exactly — the whole penny problem", () => {
    fc.assert(
      fc.property(linesArb, discountArb, (lines, discount) => {
        const total = lines.reduce((s, l) => s + l.amountSatang, 0);
        const result = allocateDiscount(lines, discount);
        const sum = result.reduce((s, r) => s + r.discountAllocatedSatang, 0);
        expect(sum).toBe(Math.min(discount, total));
      }),
    );
  });

  it("property: 0 ≤ allocation_i ≤ a_i", () => {
    fc.assert(
      fc.property(linesArb, discountArb, (lines, discount) => {
        const byId = new Map(lines.map((l) => [l.id, l.amountSatang]));
        for (const r of allocateDiscount(lines, discount)) {
          expect(r.discountAllocatedSatang).toBeGreaterThanOrEqual(0);
          expect(r.discountAllocatedSatang).toBeLessThanOrEqual(
            byId.get(r.id)!,
          );
        }
      }),
    );
  });

  it("property: |allocation_i − exact_i| < 1 satang (no residual dumping)", () => {
    fc.assert(
      fc.property(linesArb, discountArb, (lines, discount) => {
        const total = lines.reduce((s, l) => s + l.amountSatang, 0);
        if (total === 0) return;
        const clamped = Math.min(Math.max(discount, 0), total);
        const byId = new Map(lines.map((l) => [l.id, l.amountSatang]));
        for (const r of allocateDiscount(lines, discount)) {
          const exact = (clamped * byId.get(r.id)!) / total;
          expect(Math.abs(r.discountAllocatedSatang - exact)).toBeLessThan(1);
        }
      }),
    );
  });

  it("property: order-independent — shuffling lines never changes a line's allocation", () => {
    fc.assert(
      fc.property(
        linesArb,
        discountArb,
        fc.infiniteStream(fc.nat()),
        (lines, discount, seeds) => {
          const shuffled = [...lines];
          // Fisher–Yates with the fc-provided stream (deterministic per run).
          const it = seeds[Symbol.iterator]();
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = (it.next().value as number) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          const base = new Map(
            allocateDiscount(lines, discount).map((r) => [
              r.id,
              r.discountAllocatedSatang,
            ]),
          );
          for (const r of allocateDiscount(shuffled, discount)) {
            expect(r.discountAllocatedSatang).toBe(base.get(r.id));
          }
        },
      ),
    );
  });

  it("property: deterministic — same input twice, identical output", () => {
    fc.assert(
      fc.property(linesArb, discountArb, (lines, discount) => {
        expect(allocateDiscount(lines, discount)).toEqual(
          allocateDiscount(lines, discount),
        );
      }),
    );
  });
});

// ─── computeTotals (#107 #112) ──────────────────────────────

const VAT7 = { enabled: true, ratePct: 7, pricesIncludeTax: false };
const VAT7_INCL = { enabled: true, ratePct: 7, pricesIncludeTax: true };

function line(id: string, amountSatang: number): AllocatableLine {
  return { id, amountSatang };
}

describe("computeTotals — golden matrix", () => {
  it("#107 exclusive: VAT on (subtotal − discount), not the sticker price", () => {
    // 3 × ฿100, ฿30 off → consideration ฿270 → VAT 7% = ฿18.90.
    const t = computeTotals({
      lines: [line("a", 10000), line("b", 10000), line("c", 10000)],
      shippingSatang: 0,
      discountSatang: 3000,
      tax: VAT7,
    });
    expect(t.taxSatang).toBe(1890); // NOT 2100 (7% of ฿300)
    expect(t.taxIncludedSatang).toBe(0);
    expect(t.totalSatang).toBe(27000 + 1890);
  });

  it("#107 exclusive: shipping is part of the taxable base", () => {
    // subtotal ฿300 − ฿30 + shipping ฿50 = ฿320 base → VAT ฿22.40.
    const t = computeTotals({
      lines: [line("a", 30000)],
      shippingSatang: 5000,
      discountSatang: 3000,
      tax: VAT7,
    });
    expect(t.taxSatang).toBe(2240);
    expect(t.totalSatang).toBe(32000 + 2240);
  });

  it("a discounted order pays strictly less VAT than the same order undiscounted", () => {
    const base = {
      lines: [line("a", 30000)],
      shippingSatang: 0,
      tax: VAT7,
    };
    const undiscounted = computeTotals({ ...base, discountSatang: 0 });
    const discounted = computeTotals({ ...base, discountSatang: 3000 });
    expect(discounted.taxSatang).toBeLessThan(undiscounted.taxSatang);
  });

  it("#107 inclusive (Thai default): VAT extracted from the gross, total = sticker", () => {
    // gross = 30000 − 3000 + 5000 = 32000; VAT = 32000 × 7/107
    // = 2093.457… → 2093. Customer still pays ฿320.
    const t = computeTotals({
      lines: [line("a", 30000)],
      shippingSatang: 5000,
      discountSatang: 3000,
      tax: VAT7_INCL,
    });
    expect(t.taxSatang).toBe(0);
    expect(t.taxIncludedSatang).toBe(2093);
    expect(t.totalSatang).toBe(32000);
  });

  it("#112: 1,000 lines of 7 satang — order-level rounding, tax does not vanish", () => {
    // Per-line rounding gives 0 × 1000 = ฿0 tax (the audited bug).
    // Order-level: 7,000 × 7% = 490 satang exactly.
    const t = computeTotals({
      lines: Array.from({ length: 1000 }, (_, i) => line(`l${i}`, 7)),
      shippingSatang: 0,
      discountSatang: 0,
      tax: VAT7,
    });
    expect(t.taxSatang).toBe(490);
  });

  it("#112: the ฿0.01 × qty 50 case — 50 satang line taxes at 4, not 0", () => {
    // 50 × 7% = 3.5 → half-up → 4. Unit-level would round 0.07 → 0
    // fifty times and collect nothing.
    const t = computeTotals({
      lines: [line("a", 50)],
      shippingSatang: 0,
      discountSatang: 0,
      tax: VAT7,
    });
    expect(t.taxSatang).toBe(4);
  });

  it("fractional rate (6.5%) stays integer-exact", () => {
    // 20000 × 6.5% = 1300 exactly.
    const t = computeTotals({
      lines: [line("a", 20000)],
      shippingSatang: 0,
      discountSatang: 0,
      tax: { enabled: true, ratePct: 6.5, pricesIncludeTax: false },
    });
    expect(t.taxSatang).toBe(1300);
  });

  it("tax disabled / rate 0 → no tax either mode", () => {
    for (const tax of [
      { enabled: false, ratePct: 7, pricesIncludeTax: false },
      { enabled: true, ratePct: 0, pricesIncludeTax: true },
    ]) {
      const t = computeTotals({
        lines: [line("a", 10000)],
        shippingSatang: 500,
        discountSatang: 0,
        tax,
      });
      expect(t.taxSatang).toBe(0);
      expect(t.taxIncludedSatang).toBe(0);
      expect(t.totalSatang).toBe(10500);
    }
  });

  it("discount clamped to subtotal + shipping — total never negative", () => {
    const t = computeTotals({
      lines: [line("a", 10000)],
      shippingSatang: 2000,
      discountSatang: 99_999,
      tax: VAT7,
    });
    expect(t.discountSatang).toBe(12000);
    expect(t.totalSatang).toBe(0);
    expect(t.taxSatang).toBe(0);
  });

  it("free-shipping discount: nothing allocated to goods lines", () => {
    const t = computeTotals({
      lines: [line("a", 10000), line("b", 20000)],
      shippingSatang: 5000,
      discountSatang: 5000,
      discountIsFreeShipping: true,
      tax: VAT7,
    });
    // Base = 30000 + 5000 − 5000 = 30000 → tax 2100.
    expect(t.taxSatang).toBe(2100);
    expect(t.totalSatang).toBe(32100);
    expect(t.allocations.every((a) => a.discountAllocatedSatang === 0)).toBe(
      true,
    );
  });

  it("percent-code discount allocates across lines, Σ === discount", () => {
    const t = computeTotals({
      lines: [line("a", 10000), line("b", 10000), line("c", 10000)],
      shippingSatang: 0,
      discountSatang: 3000,
      tax: VAT7,
    });
    expect(
      t.allocations.reduce((s, a) => s + a.discountAllocatedSatang, 0),
    ).toBe(3000);
  });
});

describe("computeTotals — properties (#111)", () => {
  const cartArb = fc.record({
    lines: linesArb,
    shippingSatang: fc.integer({ min: 0, max: 100_000 }),
    discountSatang: fc.integer({ min: 0, max: 2_000_000 }),
    discountIsFreeShipping: fc.boolean(),
    tax: fc.record({
      enabled: fc.boolean(),
      ratePct: fc
        .integer({ min: 0, max: 2500 })
        .map((basisPoints) => basisPoints / 100), // 0–25%, 2-decimal rates
      pricesIncludeTax: fc.boolean(),
    }),
  });

  it("property: components always reconcile exactly — subtotal + shipping + tax − discount === total", () => {
    fc.assert(
      fc.property(cartArb, (input) => {
        const t = computeTotals(input);
        expect(
          t.subtotalSatang + t.shippingSatang + t.taxSatang - t.discountSatang,
        ).toBe(t.totalSatang);
      }),
    );
  });

  it("property: every output is a non-negative safe integer", () => {
    fc.assert(
      fc.property(cartArb, (input) => {
        const t = computeTotals(input);
        for (const v of [
          t.subtotalSatang,
          t.shippingSatang,
          t.discountSatang,
          t.taxSatang,
          t.taxIncludedSatang,
          t.totalSatang,
        ]) {
          expect(Number.isSafeInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("property: inclusive mode never inflates the total; extracted VAT stays inside it", () => {
    fc.assert(
      fc.property(cartArb, (input) => {
        const t = computeTotals({
          ...input,
          tax: { ...input.tax, pricesIncludeTax: true },
        });
        expect(t.taxSatang).toBe(0);
        expect(t.taxIncludedSatang).toBeLessThanOrEqual(t.totalSatang);
      }),
    );
  });

  it("property: allocations Σ === goods discount (0 for free-shipping codes)", () => {
    fc.assert(
      fc.property(cartArb, (input) => {
        const t = computeTotals(input);
        const sum = t.allocations.reduce(
          (s, a) => s + a.discountAllocatedSatang,
          0,
        );
        expect(sum).toBe(
          input.discountIsFreeShipping
            ? 0
            : Math.min(t.discountSatang, t.subtotalSatang),
        );
      }),
    );
  });
});
