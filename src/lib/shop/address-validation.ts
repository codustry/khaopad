/**
 * Address validation for checkout — #155.
 *
 * checkout/start used to cast the client-supplied address blobs
 * straight into the order row. This module is the minimum structural
 * gate: the value must actually be an OrderAddress-shaped object with
 * non-empty required strings. Deliberately market-agnostic — no Thai
 * postal-code rules, no province lists. Market-specific rules belong
 * behind the AddressValidator seam below, supplied by the deployment
 * (there is no shop plugin config surface yet; when one lands, the
 * checkout endpoint should read an optional AddressValidator from it
 * and fall back to validateOrderAddress).
 */
import type { OrderAddress } from "$plugins/shop/order-service";

export type AddressValidationResult =
  | { ok: true; address: OrderAddress }
  | { ok: false; message: string };

/**
 * The seam for market-specific validation. Same signature as the
 * default `validateOrderAddress`; a deployment can swap in a stricter
 * validator (e.g. Thai postal codes) without touching checkout code.
 */
export type AddressValidator = (value: unknown) => AddressValidationResult;

/** Required non-empty string fields on OrderAddress. */
const REQUIRED_FIELDS = [
  "name",
  "line1",
  "city",
  "postalCode",
  "countryCode",
] as const;

/** Optional fields — string or null when present. */
const OPTIONAL_FIELDS = [
  "line2",
  "region",
  "phone",
  // Tax-entity fields (#171). These existed in the checkout-slot
  // contribution type before they existed HERE — and this validator
  // builds a fresh object from these lists and silently drops anything
  // else, so the slot's tax data vanished between browser and order row
  // with no error anywhere. If you add a field to the slot contract,
  // it must be added here and to OrderAddress in the same change.
  "entityName",
  "taxId",
  "branchCode",
] as const;

/**
 * Default permissive validator. Accepts any object carrying the
 * required OrderAddress fields as non-empty strings (trimmed), plus
 * correctly-typed optional fields. Unknown extra keys are dropped, not
 * rejected — but an object made *only* of extra keys fails because the
 * required fields are missing. The returned address is a fresh object
 * so client-supplied junk never reaches the order row.
 */
export const validateOrderAddress: AddressValidator = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "Address must be an object" };
  }
  const raw = value as Record<string, unknown>;

  const out: Record<string, string | null> = {};
  for (const field of REQUIRED_FIELDS) {
    const v = raw[field];
    if (typeof v !== "string" || v.trim() === "") {
      return {
        ok: false,
        message: `Address field '${field}' is required and must be a non-empty string`,
      };
    }
    out[field] = v.trim();
  }

  // countryCode feeds the shipping-zone matcher (ISO-3166 alpha-2).
  // Format check is market-agnostic; normalized to uppercase to match
  // how zones store their codes.
  const country = out.countryCode as string;
  if (!/^[A-Za-z]{2}$/.test(country)) {
    return {
      ok: false,
      message:
        "Address field 'countryCode' must be a 2-letter ISO country code",
    };
  }
  out.countryCode = country.toUpperCase();

  for (const field of OPTIONAL_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null) {
      out[field] = null;
      continue;
    }
    if (typeof v !== "string") {
      return {
        ok: false,
        message: `Address field '${field}' must be a string when present`,
      };
    }
    const trimmed = v.trim();
    out[field] = trimmed === "" ? null : trimmed;
  }

  return { ok: true, address: out as unknown as OrderAddress };
};
