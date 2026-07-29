/**
 * Schema.org JSON-LD emitters for shop entities.
 *
 * Emitted as inline <script type="application/ld+json"> in the page
 * <head>. Google's Rich Results Test is the acceptance target
 * (google.com/rich-results). Keep serialization deterministic — no
 * Date.now(), no Math.random() — so cache-key stability is preserved.
 *
 * Canonical URL rules (must-fix from #56 design review):
 *   - Product pages canonicalize to /products/<slug> (no variant params)
 *   - Variant selection uses ?variant=<sku> but SEO consolidates to
 *     the base URL — one canonical per product, not per variant
 *
 * Not shipped yet:
 *   - AggregateRating (waits for @khaopad/plugin-reviews in v3.4 —
 *     never emit fake AggregateRating; Google flags fabricated
 *     review schema as manipulation)
 *   - Multi-variant Offers with priceSpecification — the current
 *     emitter picks the min variant price. When variants have
 *     meaningfully different prices, upgrade to itemOffered.Offer[].
 */
import { type Satang } from "./money";

type Money = Satang | number;

export type ProductJsonLdVariant = {
  sku: string | null;
  priceSatang: Money;
  available: number; // 0 = out of stock, >0 = in stock
};

export type ProductJsonLdInput = {
  siteOrigin: string; // e.g. "https://example.com"
  slug: string;
  title: string;
  description?: string | null;
  brand?: string | null;
  vendor?: string | null; // synonym for brand — brand wins if both set
  featuredImageUrl?: string | null;
  variants: ProductJsonLdVariant[];
  currency?: string; // ISO 4217, defaults to THB
};

/**
 * Escape any `<` in JSON output so an embedded `</script>` in the
 * source data cannot break out of a `<script type="application/ld+json">`
 * container and execute attacker-controlled HTML. Classic stored-XSS
 * vector for JSON-LD.
 *
 * `JSON.stringify` does NOT escape `<` by default — this replace runs
 * on the finished string to catch every occurrence regardless of where
 * in the JSON structure it landed.
 */
function escapeForScriptTag(json: string): string {
  return json.replace(/</g, "\\u003c");
}

/**
 * Emit Product + Offer JSON-LD. When there's one variant, uses a
 * single Offer. When there are multiple, uses AggregateOffer with
 * lowPrice/highPrice/offerCount. Google's Rich Results validates
 * both shapes.
 */
export function buildProductJsonLd(input: ProductJsonLdInput): string {
  const canonicalUrl = `${input.siteOrigin}/products/${input.slug}`;
  const currency = input.currency ?? "THB";
  const brand = input.brand ?? input.vendor ?? null;

  const activeVariants = input.variants.filter((v) => v.priceSatang > 0);
  const hasAnyStock = activeVariants.some((v) => v.available > 0);

  const base: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.title,
    url: canonicalUrl,
  };
  if (input.description) base.description = input.description;
  if (brand) base.brand = { "@type": "Brand", name: brand };
  if (input.featuredImageUrl) base.image = input.featuredImageUrl;

  // Google Merchant / rich results reads Offer.availability
  const availability = hasAnyStock
    ? "https://schema.org/InStock"
    : "https://schema.org/OutOfStock";

  if (activeVariants.length === 1) {
    const v = activeVariants[0]!;
    base.offers = {
      "@type": "Offer",
      url: canonicalUrl,
      priceCurrency: currency,
      // Schema.org wants a decimal number as a string — never scientific,
      // never rounded to fewer than 2 decimal places for currency.
      price: (v.priceSatang / 100).toFixed(2),
      availability,
      ...(v.sku ? { sku: v.sku } : {}),
    };
  } else if (activeVariants.length > 1) {
    const prices = activeVariants.map((v) => v.priceSatang);
    const lowPrice = Math.min(...prices);
    const highPrice = Math.max(...prices);
    base.offers = {
      "@type": "AggregateOffer",
      url: canonicalUrl,
      priceCurrency: currency,
      lowPrice: (lowPrice / 100).toFixed(2),
      highPrice: (highPrice / 100).toFixed(2),
      offerCount: activeVariants.length,
      availability,
    };
  }

  return escapeForScriptTag(JSON.stringify(base));
}

export type CollectionJsonLdInput = {
  siteOrigin: string;
  slug: string;
  title: string;
  description?: string | null;
  productSlugs: string[]; // for ItemList
};

/** ItemList JSON-LD for collection pages. Helps Google understand catalog structure. */
export function buildCollectionJsonLd(input: CollectionJsonLdInput): string {
  const canonicalUrl = `${input.siteOrigin}/collections/${input.slug}`;
  const items = input.productSlugs.map((slug, i) => ({
    "@type": "ListItem",
    position: i + 1,
    url: `${input.siteOrigin}/products/${slug}`,
  }));
  return escapeForScriptTag(
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: input.title,
      url: canonicalUrl,
      ...(input.description ? { description: input.description } : {}),
      mainEntity: {
        "@type": "ItemList",
        itemListElement: items,
        numberOfItems: items.length,
      },
    }),
  );
}
