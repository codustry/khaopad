/**
 * GET /feeds/google-merchant.xml — Google Merchant Center product feed.
 *
 * Format: Google's RSS 2.0 dialect with the `g:` namespace, described
 * at https://support.google.com/merchants/answer/7052112.
 *
 * Emits every active shop product with a purchasable variant. The
 * canonical URL points at the product page (not a variant param) so
 * Google consolidates equity to one URL — matching the design-review
 * variants-as-query-param decision from #56.
 *
 * Cached at the edge for an hour — Merchant Center polls a few times
 * a day, more frequent updates aren't worth the D1 hit.
 *
 * v3.3 minimum viable emit: id / title / description / link / image_link
 * (when featured media exists) / availability / price / brand.
 * v3.4+ additions: gtin/mpn, additional_image_link, shipping,
 * item_group_id for variants.
 */
import { error } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { resolveOrigin } from "$lib/seo";
import {
  shopInventoryItems,
  shopInventoryLevels,
  shopProductLocalizations,
  shopProductVariants,
  shopProducts,
} from "$plugins/shop/schema";
import type { RequestHandler } from "./$types";

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const GET: RequestHandler = async ({ platform, url }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const db = drizzle(env.DB);

  const origin = resolveOrigin(url, env.PUBLIC_SITE_URL);

  // Every active product with at least one active variant + inventory > 0.
  const products = await db
    .select()
    .from(shopProducts)
    .where(eq(shopProducts.status, "active"))
    .all();

  const productIds = products.map((p) => p.id);
  if (productIds.length === 0) {
    return new Response(emptyFeed(origin), {
      headers: xmlHeaders(),
    });
  }

  const variants = await db
    .select()
    .from(shopProductVariants)
    .where(
      and(
        inArray(shopProductVariants.productId, productIds),
        eq(shopProductVariants.status, "active"),
      ),
    )
    .all();

  const variantIds = variants.map((v) => v.id);
  const invItems = variantIds.length
    ? await db
        .select()
        .from(shopInventoryItems)
        .where(inArray(shopInventoryItems.variantId, variantIds))
        .all()
    : [];
  const itemsByVariant = new Map(invItems.map((i) => [i.variantId, i]));
  const invIds = invItems.map((i) => i.id);
  const invLevels = invIds.length
    ? await db
        .select()
        .from(shopInventoryLevels)
        .where(inArray(shopInventoryLevels.itemId, invIds))
        .all()
    : [];
  const levelsByItem = new Map(invLevels.map((l) => [l.itemId, l]));

  // English localizations for title/description (feed doesn't yet do
  // per-locale variants — v3.4 will emit language-tagged copies).
  const enLocs = await db
    .select()
    .from(shopProductLocalizations)
    .where(
      and(
        inArray(shopProductLocalizations.productId, productIds),
        eq(shopProductLocalizations.locale, "en"),
      ),
    )
    .all();
  const enByProduct = new Map(enLocs.map((l) => [l.productId, l]));

  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const arr = variantsByProduct.get(v.productId) ?? [];
    arr.push(v);
    variantsByProduct.set(v.productId, arr);
  }

  const items: string[] = [];
  for (const product of products) {
    const prodVariants = variantsByProduct.get(product.id) ?? [];
    if (prodVariants.length === 0) continue;

    // Determine stock: any variant with available > 0 (or untracked
    // inventory items) → in stock.
    let inStock = false;
    for (const v of prodVariants) {
      const inv = itemsByVariant.get(v.id);
      if (!inv?.tracked) {
        inStock = true;
        break;
      }
      const level = levelsByItem.get(inv.id);
      if (level && level.onHand - level.reserved > 0) {
        inStock = true;
        break;
      }
    }
    if (!inStock) continue;

    // Cheapest variant price for the feed. Google treats this as the
    // display price; variants share one product listing.
    const minPriceSatang = Math.min(...prodVariants.map((v) => v.priceSatang));
    if (!Number.isFinite(minPriceSatang) || minPriceSatang <= 0) continue;

    const loc = enByProduct.get(product.id);
    const title = loc?.title ?? product.slug;
    const description = loc?.descriptionMarkdown ?? title;
    const link = `${origin}/en/products/${product.slug}`;
    const priceStr = `${(minPriceSatang / 100).toFixed(2)} THB`;
    const availability = "in_stock";

    const parts = [
      `      <g:id>${escapeXml(product.id)}</g:id>`,
      `      <title>${escapeXml(title.slice(0, 150))}</title>`,
      `      <description>${escapeXml(description.slice(0, 5000))}</description>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <g:condition>new</g:condition>`,
      `      <g:availability>${availability}</g:availability>`,
      `      <g:price>${escapeXml(priceStr)}</g:price>`,
    ];
    if (product.featuredMediaId) {
      const imageLink = `${origin}/api/media/${product.featuredMediaId}`;
      parts.push(`      <g:image_link>${escapeXml(imageLink)}</g:image_link>`);
    }
    if (product.vendor) {
      parts.push(`      <g:brand>${escapeXml(product.vendor.slice(0, 70))}</g:brand>`);
    }

    items.push(`    <item>\n${parts.join("\n")}\n    </item>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Khao Pad shop</title>
    <link>${escapeXml(origin)}</link>
    <description>Product feed for Google Merchant Center.</description>
${items.join("\n")}
  </channel>
</rss>`;

  return new Response(xml, { headers: xmlHeaders() });
};

function xmlHeaders() {
  return {
    "content-type": "application/xml; charset=utf-8",
    "cache-control": "public, max-age=3600, s-maxage=3600",
  };
}

function emptyFeed(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Khao Pad shop</title>
    <link>${escapeXml(origin)}</link>
    <description>Product feed for Google Merchant Center.</description>
  </channel>
</rss>`;
}
