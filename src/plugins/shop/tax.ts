/**
 * Tax rate resolution — reads site settings + per-country overrides
 * and returns the applicable rate for an order.
 *
 * v3.15 (#107/#112): the tax MATH lives in totals.ts (pure,
 * order-level rounding, discount-aware). This module only answers
 * "which rate applies to this destination?" — the old
 * `calculateTax()` (per-line rounding on the undiscounted subtotal)
 * was removed; it never had a caller and both behaviors were the
 * audited bugs.
 *
 * Model:
 *   - Site setting `shop.tax` = { enabled, defaultRatePct,
 *     pricesIncludeTax, defaultTaxName }
 *   - Per-country override rows in shop_tax_rates (composite PK
 *     country + region; region="" means country-wide).
 *
 * `pricesIncludeTax=true` (Thailand default): displayed prices
 * already include VAT — tax is broken out on the invoice, the
 * customer pays the sticker price.
 *
 * `pricesIncludeTax=false` (US-style): tax added on top at checkout.
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

const DISABLED_DEFAULTS: ShopTaxSettings = {
  enabled: false,
  defaultRatePct: 0,
  pricesIncludeTax: false,
  defaultTaxName: "VAT",
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
  if (!row) return DISABLED_DEFAULTS;
  try {
    const parsed = JSON.parse(row.value) as Partial<ShopTaxSettings>;
    return {
      enabled: parsed.enabled ?? false,
      defaultRatePct: parsed.defaultRatePct ?? 0,
      pricesIncludeTax: parsed.pricesIncludeTax ?? false,
      defaultTaxName: parsed.defaultTaxName ?? "VAT",
    };
  } catch {
    return DISABLED_DEFAULTS;
  }
}

export type ResolvedTaxRate = {
  enabled: boolean;
  /** Percent, may be fractional. 0 when disabled or zero-rated. */
  ratePct: number;
  pricesIncludeTax: boolean;
  /** "VAT" / "GST" / override row's name — for receipts. */
  name: string;
};

/**
 * Resolve the tax rate for a destination. Lookup order: exact
 * (country, region) override → country-wide (country, "") override
 * → site default rate. Feed the result straight into
 * `computeTotals()` in totals.ts as its `tax` input.
 */
export async function resolveTaxRate(
  d1: D1Database,
  destination: { countryCode: string; regionCode?: string },
): Promise<ResolvedTaxRate> {
  const settings = await loadTaxSettings(d1);
  if (!settings.enabled) {
    return {
      enabled: false,
      ratePct: 0,
      pricesIncludeTax: settings.pricesIncludeTax,
      name: settings.defaultTaxName,
    };
  }

  const db = drizzle(d1);
  const upperCountry = destination.countryCode.toUpperCase();
  const upperRegion = (destination.regionCode ?? "").toUpperCase();

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
  return {
    enabled: true,
    ratePct: override?.ratePct ?? settings.defaultRatePct,
    pricesIncludeTax: settings.pricesIncludeTax,
    name: override?.name ?? settings.defaultTaxName,
  };
}
