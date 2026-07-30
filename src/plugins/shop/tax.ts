/**
 * Tax calculator — reads site settings + per-country overrides,
 * returns tax lines for the order.
 *
 * v3.2 model:
 *   - Site setting `shop.tax` = { enabled, defaultRatePct,
 *     pricesIncludeTax, defaultTaxName }
 *   - Per-country override rows in shop_tax_rates (composite PK
 *     country + region; region="" means country-wide).
 *
 * `pricesIncludeTax=true` (Thailand default): displayed prices
 * already include VAT. Tax is broken out on the invoice — the
 * customer still pays the sticker price, not sticker + tax.
 *
 * `pricesIncludeTax=false` (US-style): tax added on top at checkout.
 *
 * Thailand-specific: v3.4 adds a 3% withholding-tax line on
 * customers flagged as B2B — modeled as a negative order_adjustments
 * row (kind='withholding_tax'), not a tax line here.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { shopTaxRates } from "./schema-shipping-tax";
import { siteSettings } from "$lib/server/content/schema";

export type ShopTaxSettings = {
  enabled: boolean;
  defaultRatePct: number;
  pricesIncludeTax: boolean;
  defaultTaxName: string;
};

export type TaxContext = {
  countryCode: string;
  regionCode?: string;
  subtotalSatang: number;
  /** Per-item breakdown so per-line tax lines can be emitted. */
  items?: Array<{ orderItemId: string; lineSubtotalSatang: number }>;
};

export type TaxLine = {
  orderItemId: string | null;
  name: string;
  ratePct: number;
  amountSatang: number;
};

export type TaxCalculation = {
  /** Total tax to add to the order (or 0 when pricesIncludeTax). */
  totalTaxSatang: number;
  /** Portion of subtotal that IS tax (only meaningful when pricesIncludeTax). */
  taxIncludedSatang: number;
  lines: TaxLine[];
};

/**
 * Load the tax settings from site_settings. Returns disabled-defaults
 * if the setting hasn't been created — checkout treats disabled tax
 * as "0% everywhere".
 */
export async function loadTaxSettings(
  d1: D1Database,
): Promise<ShopTaxSettings> {
  const db = drizzle(d1);
  const row = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.key, "shop.tax"))
    .limit(1)
    .get();
  if (!row) {
    return {
      enabled: false,
      defaultRatePct: 0,
      pricesIncludeTax: false,
      defaultTaxName: "VAT",
    };
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<ShopTaxSettings>;
    return {
      enabled: parsed.enabled ?? false,
      defaultRatePct: parsed.defaultRatePct ?? 0,
      pricesIncludeTax: parsed.pricesIncludeTax ?? false,
      defaultTaxName: parsed.defaultTaxName ?? "VAT",
    };
  } catch {
    return {
      enabled: false,
      defaultRatePct: 0,
      pricesIncludeTax: false,
      defaultTaxName: "VAT",
    };
  }
}

/**
 * Compute tax for an order. `pricesIncludeTax=true` mode returns
 * `totalTaxSatang: 0` (customer already paid the sticker price)
 * and populates `taxIncludedSatang` so the receipt can show the
 * split. `pricesIncludeTax=false` mode returns the tax-to-add.
 */
export async function calculateTax(
  d1: D1Database,
  ctx: TaxContext,
): Promise<TaxCalculation> {
  const settings = await loadTaxSettings(d1);
  if (!settings.enabled) {
    return { totalTaxSatang: 0, taxIncludedSatang: 0, lines: [] };
  }

  const db = drizzle(d1);
  const upperCountry = ctx.countryCode.toUpperCase();
  const upperRegion = (ctx.regionCode ?? "").toUpperCase();

  // Look up: exact match (country, region) → country-wide (country, "")
  // → fall back to site default rate.
  let rate: number = settings.defaultRatePct;
  let name: string = settings.defaultTaxName;

  const exact = upperRegion
    ? await db
        .select()
        .from(shopTaxRates)
        .where(
          and(
            eq(shopTaxRates.countryCode, upperCountry),
            eq(shopTaxRates.regionCode, upperRegion),
            eq(shopTaxRates.active, true),
          ),
        )
        .limit(1)
        .get()
    : null;

  const countryWide = exact
    ? null
    : await db
        .select()
        .from(shopTaxRates)
        .where(
          and(
            eq(shopTaxRates.countryCode, upperCountry),
            eq(shopTaxRates.regionCode, ""),
            eq(shopTaxRates.active, true),
          ),
        )
        .limit(1)
        .get();

  const override = exact ?? countryWide;
  if (override) {
    rate = override.ratePct;
    name = override.name;
  }

  if (rate === 0) {
    return { totalTaxSatang: 0, taxIncludedSatang: 0, lines: [] };
  }

  const lines: TaxLine[] = [];
  let totalTaxSatang = 0;
  let taxIncludedSatang = 0;

  if (settings.pricesIncludeTax) {
    // Sticker prices already include tax. Break out the tax portion:
    //   taxPortion = subtotal * (rate / (100 + rate))
    // Round each line separately then sum — matches receipt readability.
    if (ctx.items) {
      for (const item of ctx.items) {
        const taxPortion = Math.round(
          (item.lineSubtotalSatang * rate) / (100 + rate),
        );
        taxIncludedSatang += taxPortion;
        lines.push({
          orderItemId: item.orderItemId,
          name,
          ratePct: rate,
          amountSatang: taxPortion,
        });
      }
    } else {
      taxIncludedSatang = Math.round(
        (ctx.subtotalSatang * rate) / (100 + rate),
      );
      lines.push({
        orderItemId: null,
        name,
        ratePct: rate,
        amountSatang: taxIncludedSatang,
      });
    }
    // Total to ADD is 0 — sticker price already covers tax.
  } else {
    // Add tax on top. Round per-line, sum, that becomes totalTaxSatang.
    if (ctx.items) {
      for (const item of ctx.items) {
        const tax = Math.round((item.lineSubtotalSatang * rate) / 100);
        totalTaxSatang += tax;
        lines.push({
          orderItemId: item.orderItemId,
          name,
          ratePct: rate,
          amountSatang: tax,
        });
      }
    } else {
      totalTaxSatang = Math.round((ctx.subtotalSatang * rate) / 100);
      lines.push({
        orderItemId: null,
        name,
        ratePct: rate,
        amountSatang: totalTaxSatang,
      });
    }
  }

  return { totalTaxSatang, taxIncludedSatang, lines };
}
