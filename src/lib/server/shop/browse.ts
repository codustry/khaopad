/**
 * Storefront browse data loading — assembles `BrowseProduct[]` from D1.
 *
 * Server-only counterpart to `$lib/components/shop/browse` (which is
 * pure and testable). The in-memory join style mirrors
 * ShopService.listProducts(): one query per table, joined in maps, so
 * a page load costs a fixed number of D1 round trips regardless of
 * catalog size.
 *
 * All `inArray` calls are chunked to 100 ids — D1 binds at most 100
 * parameters per statement (same constraint listCollectionsForAdmin
 * documents).
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import {
  shopCollectionLocalizations,
  shopCollectionProducts,
  shopCollections,
  shopInventoryItems,
  shopInventoryLevels,
  shopProductLocalizations,
  shopProductOptionValues,
  shopProductOptions,
  shopProductVariantOptions,
  shopProductVariants,
  shopProducts,
} from "$plugins/shop/schema";
import type { BrowseProduct } from "$lib/components/shop/browse";

const CHUNK = 100;

function chunks<T>(ids: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}

async function chunkedAll<T, R>(
  ids: T[],
  query: (chunk: T[]) => Promise<R[]>,
): Promise<R[]> {
  if (ids.length === 0) return [];
  const groups = await Promise.all(chunks(ids).map(query));
  return groups.flat();
}

export type BrowseCollection = {
  id: string;
  slug: string;
  featuredMediaId: string | null;
  /** locale → title (English fallback resolved at render time). */
  titles: Record<string, string>;
  productCount: number;
};

/**
 * All active products hydrated to the shape the browse pipeline
 * filters on. Pass `productIds` to scope to a collection (order of the
 * result is NOT the input order — reorder at the call site if the
 * manual collection position matters).
 */
export async function loadBrowseProducts(
  d1: D1Database,
  opts: { productIds?: string[] } = {},
): Promise<BrowseProduct[]> {
  const db = drizzle(d1);

  const products = opts.productIds
    ? await chunkedAll(opts.productIds, (c) =>
        db
          .select()
          .from(shopProducts)
          .where(
            and(inArray(shopProducts.id, c), eq(shopProducts.status, "active")),
          )
          .all(),
      )
    : await db
        .select()
        .from(shopProducts)
        .where(eq(shopProducts.status, "active"))
        .all();
  if (products.length === 0) return [];
  const productIds = products.map((p) => p.id);

  const [locs, options, variants, collectionLinks] = await Promise.all([
    chunkedAll(productIds, (c) =>
      db
        .select()
        .from(shopProductLocalizations)
        .where(inArray(shopProductLocalizations.productId, c))
        .all(),
    ),
    chunkedAll(productIds, (c) =>
      db
        .select()
        .from(shopProductOptions)
        .where(inArray(shopProductOptions.productId, c))
        .all(),
    ),
    chunkedAll(productIds, (c) =>
      db
        .select()
        .from(shopProductVariants)
        .where(
          and(
            inArray(shopProductVariants.productId, c),
            eq(shopProductVariants.status, "active"),
          ),
        )
        .all(),
    ),
    chunkedAll(productIds, (c) =>
      db
        .select({
          productId: shopCollectionProducts.productId,
          slug: shopCollections.slug,
          status: shopCollections.status,
        })
        .from(shopCollectionProducts)
        .innerJoin(
          shopCollections,
          eq(shopCollections.id, shopCollectionProducts.collectionId),
        )
        .where(inArray(shopCollectionProducts.productId, c))
        .all(),
    ),
  ]);

  const optionIds = options.map((o) => o.id);
  const variantIds = variants.map((v) => v.id);

  const [optionValues, variantOptions, items] = await Promise.all([
    chunkedAll(optionIds, (c) =>
      db
        .select()
        .from(shopProductOptionValues)
        .where(inArray(shopProductOptionValues.optionId, c))
        .all(),
    ),
    chunkedAll(variantIds, (c) =>
      db
        .select()
        .from(shopProductVariantOptions)
        .where(inArray(shopProductVariantOptions.variantId, c))
        .all(),
    ),
    chunkedAll(variantIds, (c) =>
      db
        .select()
        .from(shopInventoryItems)
        .where(inArray(shopInventoryItems.variantId, c))
        .all(),
    ),
  ]);

  const levels = await chunkedAll(
    items.map((i) => i.id),
    (c) =>
      db
        .select()
        .from(shopInventoryLevels)
        .where(inArray(shopInventoryLevels.itemId, c))
        .all(),
  );

  // ── Index everything ──
  const titlesByProduct = new Map<string, Record<string, string>>();
  for (const l of locs) {
    const rec = titlesByProduct.get(l.productId) ?? {};
    rec[l.locale] = l.title;
    titlesByProduct.set(l.productId, rec);
  }

  const optionById = new Map(options.map((o) => [o.id, o]));
  const valueById = new Map(optionValues.map((v) => [v.id, v]));
  const variantById = new Map(variants.map((v) => [v.id, v]));

  // Only option values actually used by an ACTIVE variant facet —
  // a value that exists on the product but sells nothing must not
  // render as a filter that filters to zero.
  const optionValuesByProduct = new Map<string, Map<string, Set<string>>>();
  for (const vo of variantOptions) {
    const variant = variantById.get(vo.variantId);
    const value = valueById.get(vo.optionValueId);
    if (!variant || !value) continue;
    const option = optionById.get(value.optionId);
    if (!option) continue;
    const byName =
      optionValuesByProduct.get(variant.productId) ??
      new Map<string, Set<string>>();
    const set = byName.get(option.name) ?? new Set<string>();
    set.add(value.value);
    byName.set(option.name, set);
    optionValuesByProduct.set(variant.productId, byName);
  }

  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const arr = variantsByProduct.get(v.productId) ?? [];
    arr.push(v);
    variantsByProduct.set(v.productId, arr);
  }

  const itemByVariant = new Map(items.map((i) => [i.variantId, i]));
  const levelByItem = new Map(levels.map((l) => [l.itemId, l]));

  const collectionSlugsByProduct = new Map<string, string[]>();
  for (const link of collectionLinks) {
    if (link.status !== "active") continue; // draft collections don't facet
    const arr = collectionSlugsByProduct.get(link.productId) ?? [];
    arr.push(link.slug);
    collectionSlugsByProduct.set(link.productId, arr);
  }

  return products.map((p) => {
    const productVariants = variantsByProduct.get(p.id) ?? [];
    const prices = productVariants.map((v) => v.priceSatang);
    const inStock = productVariants.some((v) => {
      const item = itemByVariant.get(v.id);
      if (!item) return false;
      if (!item.tracked || item.continueSellingWhenOutOfStock) return true;
      const level = levelByItem.get(item.id);
      if (!level) return false;
      return level.onHand - level.reserved > 0;
    });
    const optionValuesRec: Record<string, string[]> = {};
    for (const [name, set] of optionValuesByProduct.get(p.id) ?? []) {
      optionValuesRec[name] = Array.from(set).sort((a, b) =>
        a.localeCompare(b),
      );
    }
    return {
      id: p.id,
      slug: p.slug,
      vendor: p.vendor,
      productType: p.productType,
      featuredMediaId: p.featuredMediaId,
      createdAt: p.createdAt,
      publishedAt: p.publishedAt,
      titles: titlesByProduct.get(p.id) ?? {},
      priceMinSatang: prices.length ? Math.min(...prices) : null,
      priceMaxSatang: prices.length ? Math.max(...prices) : null,
      inStock,
      optionValues: optionValuesRec,
      collectionSlugs: collectionSlugsByProduct.get(p.id) ?? [],
    };
  });
}

/**
 * Active collections with localized titles + counts of ACTIVE products,
 * for the /collections index and the collection facet labels.
 */
export async function loadActiveCollections(
  d1: D1Database,
): Promise<BrowseCollection[]> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(shopCollections)
    .where(eq(shopCollections.status, "active"))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [locs, links] = await Promise.all([
    chunkedAll(ids, (c) =>
      db
        .select()
        .from(shopCollectionLocalizations)
        .where(inArray(shopCollectionLocalizations.collectionId, c))
        .all(),
    ),
    chunkedAll(ids, (c) =>
      db
        .select({
          collectionId: shopCollectionProducts.collectionId,
          productStatus: shopProducts.status,
        })
        .from(shopCollectionProducts)
        .innerJoin(
          shopProducts,
          eq(shopProducts.id, shopCollectionProducts.productId),
        )
        .where(inArray(shopCollectionProducts.collectionId, c))
        .all(),
    ),
  ]);

  const titlesByCollection = new Map<string, Record<string, string>>();
  for (const l of locs) {
    const rec = titlesByCollection.get(l.collectionId) ?? {};
    rec[l.locale] = l.title;
    titlesByCollection.set(l.collectionId, rec);
  }
  const counts = new Map<string, number>();
  for (const l of links) {
    if (l.productStatus !== "active") continue;
    counts.set(l.collectionId, (counts.get(l.collectionId) ?? 0) + 1);
  }

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    featuredMediaId: r.featuredMediaId,
    titles: titlesByCollection.get(r.id) ?? {},
    productCount: counts.get(r.id) ?? 0,
  }));
}
