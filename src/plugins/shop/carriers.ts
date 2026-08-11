/**
 * Thai carrier presets (C1) — the carriers a Thai SMB actually ships
 * with, plus their public tracking-URL string templates.
 *
 * Pure data + string substitution, deliberately tiny: tracking pages
 * change URLs occasionally, and when they do this file is the only
 * thing to touch. `{tracking}` is replaced with the URL-encoded
 * tracking number. 'other' has no template — the admin can still
 * record a number, it just renders as plain text.
 */

export type CarrierDef = {
  /** Stable id stored in shop_fulfillments.carrier. */
  id: string;
  /** Human label (EN — carrier brand names are not translated). */
  label: string;
  /** Tracking page template with a `{tracking}` placeholder, or null. */
  trackingUrlTemplate: string | null;
};

export const CARRIERS: readonly CarrierDef[] = [
  {
    id: "thailand_post",
    label: "Thailand Post",
    trackingUrlTemplate:
      "https://track.thailandpost.co.th/?trackNumber={tracking}",
  },
  {
    id: "kerry",
    label: "Kerry Express",
    trackingUrlTemplate:
      "https://th.kerryexpress.com/th/track/?track={tracking}",
  },
  {
    id: "flash",
    label: "Flash Express",
    trackingUrlTemplate:
      "https://www.flashexpress.com/fle/tracking?se={tracking}",
  },
  {
    id: "jt",
    label: "J&T Express",
    trackingUrlTemplate:
      "https://www.jtexpress.co.th/service/track?waybill={tracking}",
  },
  {
    id: "dhl",
    label: "DHL",
    trackingUrlTemplate:
      "https://www.dhl.com/th-en/home/tracking.html?tracking-id={tracking}",
  },
  { id: "other", label: "Other", trackingUrlTemplate: null },
] as const;

/** Label for a stored carrier id; falls back to the raw id. */
export function carrierLabel(carrierId: string | null | undefined): string {
  if (!carrierId) return "";
  return CARRIERS.find((c) => c.id === carrierId)?.label ?? carrierId;
}

/**
 * Public tracking URL for (carrier, trackingNumber), or null when the
 * carrier has no template or either input is missing.
 */
export function trackingUrl(
  carrierId: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (!carrierId || !trackingNumber) return null;
  const def = CARRIERS.find((c) => c.id === carrierId);
  if (!def?.trackingUrlTemplate) return null;
  return def.trackingUrlTemplate.replace(
    "{tracking}",
    encodeURIComponent(trackingNumber),
  );
}
