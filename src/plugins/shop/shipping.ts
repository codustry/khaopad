/**
 * Shipping calculator — matches a destination address + cart weight/
 * subtotal against configured zones and returns eligible methods with
 * prices.
 *
 * Algorithm:
 *   1. Pick the zone: first zone (ascending priority) whose
 *      countryCodes contains the address's countryCode. "*" matches
 *      any country (fallback zone).
 *   2. Filter methods by min/max weight + min/max subtotal.
 *   3. Compute rate per method:
 *        flat: single rate row
 *        weight_bracket: bracket walk on totalWeightGrams
 *        price_bracket: bracket walk on subtotalSatang
 *        free_over: 0 if subtotal >= upperBoundSatang, else Infinity
 *   4. Return methods with finite rates.
 *
 * If no zone matches (all zones exclude this country), returns empty
 * array — checkout surfaces "we don't ship to your country".
 */
import { drizzle } from "drizzle-orm/d1";
import { asc, eq, inArray } from "drizzle-orm";
import {
  shopShippingMethods,
  shopShippingRates,
  shopShippingZones,
  type ShopShippingMethod,
  type ShopShippingRate,
  type ShopShippingZone,
} from "./schema-shipping-tax";

export type ShippingContext = {
  countryCode: string; // ISO-3166 alpha-2
  totalWeightGrams: number;
  subtotalSatang: number;
};

export type ShippingQuote = {
  methodId: string;
  name: string;
  amountSatang: number;
};

/**
 * Return shipping quotes eligible for the cart at the given address.
 * Sorted by amount ascending — cheapest first, so a naive UI can
 * default to `quotes[0]` without further work.
 */
export async function quoteShipping(
  d1: D1Database,
  ctx: ShippingContext,
): Promise<ShippingQuote[]> {
  const db = drizzle(d1);
  const zones = await db
    .select()
    .from(shopShippingZones)
    .orderBy(asc(shopShippingZones.priority))
    .all();

  const zone = pickZone(zones, ctx.countryCode);
  if (!zone) return [];

  const methods = await db
    .select()
    .from(shopShippingMethods)
    .where(eq(shopShippingMethods.zoneId, zone.id))
    .orderBy(asc(shopShippingMethods.position))
    .all();

  const eligibleMethods = methods.filter((m) => {
    if (!m.active) return false;
    if (m.minWeightGrams != null && ctx.totalWeightGrams < m.minWeightGrams)
      return false;
    if (m.maxWeightGrams != null && ctx.totalWeightGrams > m.maxWeightGrams)
      return false;
    if (m.minSubtotalSatang != null && ctx.subtotalSatang < m.minSubtotalSatang)
      return false;
    if (m.maxSubtotalSatang != null && ctx.subtotalSatang > m.maxSubtotalSatang)
      return false;
    return true;
  });

  if (eligibleMethods.length === 0) return [];

  const rates = await db
    .select()
    .from(shopShippingRates)
    .where(
      inArray(
        shopShippingRates.methodId,
        eligibleMethods.map((m) => m.id),
      ),
    )
    .all();
  const ratesByMethod = new Map<string, ShopShippingRate[]>();
  for (const r of rates) {
    const arr = ratesByMethod.get(r.methodId) ?? [];
    arr.push(r);
    ratesByMethod.set(r.methodId, arr);
  }

  const quotes: ShippingQuote[] = [];
  for (const m of eligibleMethods) {
    const methodRates = ratesByMethod.get(m.id) ?? [];
    if (methodRates.length === 0) continue;
    const amount = computeRate(m, methodRates, ctx);
    if (amount === null || !Number.isFinite(amount)) continue;
    quotes.push({
      methodId: m.id,
      name: m.name,
      amountSatang: amount,
    });
  }
  return quotes.sort((a, b) => a.amountSatang - b.amountSatang);
}

function pickZone(
  zones: ShopShippingZone[],
  countryCode: string,
): ShopShippingZone | null {
  const upper = countryCode.toUpperCase();
  for (const z of zones) {
    let codes: string[];
    try {
      codes = JSON.parse(z.countryCodes) as string[];
    } catch {
      continue;
    }
    if (codes.includes("*") || codes.includes(upper)) return z;
  }
  return null;
}

function computeRate(
  method: ShopShippingMethod,
  rates: ShopShippingRate[],
  ctx: ShippingContext,
): number | null {
  switch (method.rateType) {
    case "flat":
      return rates[0]?.amountSatang ?? null;
    case "weight_bracket":
      return walkBrackets(rates, ctx.totalWeightGrams, "grams");
    case "price_bracket":
      return walkBrackets(rates, ctx.subtotalSatang, "satang");
    case "free_over": {
      const row = rates[0];
      if (!row?.upperBoundSatang) return null;
      return ctx.subtotalSatang >= row.upperBoundSatang
        ? 0
        : Number.POSITIVE_INFINITY;
    }
  }
}

function walkBrackets(
  rates: ShopShippingRate[],
  value: number,
  unit: "grams" | "satang",
): number | null {
  const key = unit === "grams" ? "upperBoundGrams" : "upperBoundSatang";
  // Sort ascending by upper bound (NULL = infinity last).
  const sorted = [...rates].sort((a, b) => {
    const ai = a[key] ?? Number.POSITIVE_INFINITY;
    const bi = b[key] ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });
  for (const r of sorted) {
    const upper = r[key] ?? Number.POSITIVE_INFINITY;
    if (value <= upper) return r.amountSatang;
  }
  return null;
}
