/**
 * Related-product recommendations for the storefront product page
 * (#160 Phase A, deliverable A5).
 *
 * Three signals, merged in rank order:
 *
 *   1. **Order co-occurrence** (strongest) — products whose variants
 *      appear in the same shop_orders as this product's variants,
 *      weighted by how many distinct order lines they share. "People
 *      who bought this also bought…" beats any editorial guess.
 *   2. **Same collection** — other members of the collections this
 *      product belongs to (shop_collection_products), ordered by their
 *      curated position.
 *   3. **Catalog affinity** — products sharing product_type, vendor,
 *      or option values ('M', 'Red', …) with this product.
 *
 *      NOTE: the typed spec layer (attribute_values, #88) was the
 *      intended source for this signal, but as of v3.13 nothing writes
 *      spec rows for shop entities — the admin editor only attaches
 *      values with entityType 'entry' (registry entries), and the
 *      public specs API merely *allows* 'shop_product'/'shop_variant'.
 *      Scoring on empty tables would silence the signal entirely, so
 *      it runs against product_type + vendor + shared option values
 *      instead. Swap to attribute_values once the shop admin grows a
 *      spec editor.
 *
 * The current product is always excluded, only `status='active'`
 * products are returned, and every `IN (...)` list is chunked under
 * D1's 100-bound-parameter ceiling (same discipline as
 * `D1ContentProvider.loadChunked`).
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import {
  shopCollectionProducts,
  shopProductLocalizations,
  shopProductOptionValues,
  shopProductOptions,
  shopProductVariants,
  shopProducts,
} from "./schema";
import { shopOrderItems } from "./schema-cart";

/**
 * D1 binds at most 100 parameters per statement — and several queries
 * here bind literals BESIDES the id list (a `status = 'active'`
 * filter counts against the ceiling too). Chunk below the ceiling so
 * a full chunk plus its non-id params can never hit 101.
 */
const ID_CHUNK_SIZE = 90;

/**
 * Cap per-signal candidate pools. Keeps the catalog-affinity signal
 * (which can match half the store on a popular vendor) from dragging
 * hundreds of ids through the ranking merge for a strip of 8.
 */
const SIGNAL_CANDIDATE_CAP = 50;

export type RelatedProduct = {
  id: string;
  slug: string;
  featuredMediaId: string | null;
  /** Cheapest active variant's price, null when no active variants. */
  priceFromSatang: number | null;
  /** locale → title, resolved to the requested locale by the caller. */
  titles: Record<string, string>;
};

/**
 * Run an `inArray`-style load in chunks that respect D1's 100-bound-
 * parameter ceiling. Sequential by design — D1 counts each statement
 * against the per-invocation query budget.
 */
async function loadChunked<T>(
  ids: string[],
  load: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  if (ids.length <= ID_CHUNK_SIZE) return load(ids);
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    out.push(...(await load(ids.slice(i, i + ID_CHUNK_SIZE))));
  }
  return out;
}

export async function relatedProducts(
  d1: D1Database,
  { productId, limit = 8 }: { productId: string; limit?: number },
): Promise<RelatedProduct[]> {
  if (limit <= 0) return [];
  const db = drizzle(d1);

  // Shared inputs: this product's row (for product_type/vendor) and
  // its variant ids (for order co-occurrence).
  const [self, ownVariants] = await Promise.all([
    db
      .select({
        productType: shopProducts.productType,
        vendor: shopProducts.vendor,
      })
      .from(shopProducts)
      .where(eq(shopProducts.id, productId))
      .limit(1)
      .all(),
    db
      .select({ id: shopProductVariants.id })
      .from(shopProductVariants)
      .where(eq(shopProductVariants.productId, productId))
      .all(),
  ]);
  if (self.length === 0) return [];

  // ─── Signal 1: order co-occurrence ────────────────────────
  const orderIdRows = await loadChunked(
    ownVariants.map((v) => v.id),
    (chunk) =>
      db
        .select({ orderId: shopOrderItems.orderId })
        .from(shopOrderItems)
        .where(inArray(shopOrderItems.variantId, chunk))
        .all(),
  );
  const orderIds = [...new Set(orderIdRows.map((r) => r.orderId))];
  const coRows = await loadChunked(orderIds, (chunk) =>
    db
      .select({ productId: shopProductVariants.productId })
      .from(shopOrderItems)
      .innerJoin(
        shopProductVariants,
        eq(shopOrderItems.variantId, shopProductVariants.id),
      )
      .where(inArray(shopOrderItems.orderId, chunk))
      .all(),
  );
  const coCounts = new Map<string, number>();
  for (const row of coRows) {
    if (row.productId === productId) continue;
    coCounts.set(row.productId, (coCounts.get(row.productId) ?? 0) + 1);
  }
  const coOccurring = [...coCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SIGNAL_CANDIDATE_CAP)
    .map(([id]) => id);

  // ─── Signal 2: same collection(s) ─────────────────────────
  const collectionRows = await db
    .select({ collectionId: shopCollectionProducts.collectionId })
    .from(shopCollectionProducts)
    .where(eq(shopCollectionProducts.productId, productId))
    .all();
  const memberRows = await loadChunked(
    collectionRows.map((r) => r.collectionId),
    (chunk) =>
      db
        .select({
          productId: shopCollectionProducts.productId,
          position: shopCollectionProducts.position,
        })
        .from(shopCollectionProducts)
        .where(inArray(shopCollectionProducts.collectionId, chunk))
        .all(),
  );
  const collectionPos = new Map<string, number>();
  for (const row of memberRows) {
    if (row.productId === productId) continue;
    const prev = collectionPos.get(row.productId);
    if (prev === undefined || row.position < prev) {
      collectionPos.set(row.productId, row.position);
    }
  }
  const sameCollection = [...collectionPos.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, SIGNAL_CANDIDATE_CAP)
    .map(([id]) => id);

  // ─── Signal 3: catalog affinity (spec-layer fallback) ─────
  // product_type match outranks vendor match outranks shared option
  // values. See the file header for why this isn't attribute_values.
  const { productType, vendor } = self[0];
  const affinityScore = new Map<string, number>(); // lower = better
  if (productType || vendor) {
    const typeVendorRows = await db
      .select({
        id: shopProducts.id,
        productType: shopProducts.productType,
        vendor: shopProducts.vendor,
      })
      .from(shopProducts)
      .where(
        and(
          eq(shopProducts.status, "active"),
          ne(shopProducts.id, productId),
          or(
            productType ? eq(shopProducts.productType, productType) : undefined,
            vendor ? eq(shopProducts.vendor, vendor) : undefined,
          ),
        ),
      )
      .limit(SIGNAL_CANDIDATE_CAP)
      .all();
    for (const row of typeVendorRows) {
      const score = productType && row.productType === productType ? 0 : 1;
      const prev = affinityScore.get(row.id);
      if (prev === undefined || score < prev) affinityScore.set(row.id, score);
    }
  }
  // Shared option values ('M', 'Red') — the closest structural analog
  // to shared spec attributes the catalog currently has.
  const ownValueRows = await db
    .select({ value: shopProductOptionValues.value })
    .from(shopProductOptionValues)
    .innerJoin(
      shopProductOptions,
      eq(shopProductOptionValues.optionId, shopProductOptions.id),
    )
    .where(eq(shopProductOptions.productId, productId))
    .all();
  const ownValues = [...new Set(ownValueRows.map((r) => r.value))];
  const sharedValueRows = await loadChunked(ownValues, (chunk) =>
    db
      .select({ productId: shopProductOptions.productId })
      .from(shopProductOptionValues)
      .innerJoin(
        shopProductOptions,
        eq(shopProductOptionValues.optionId, shopProductOptions.id),
      )
      .where(inArray(shopProductOptionValues.value, chunk))
      .all(),
  );
  for (const row of sharedValueRows) {
    if (row.productId === productId) continue;
    if (!affinityScore.has(row.productId)) affinityScore.set(row.productId, 2);
  }
  const affinity = [...affinityScore.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, SIGNAL_CANDIDATE_CAP)
    .map(([id]) => id);

  // ─── Merge: co-occurrence → collection → affinity ─────────
  const ranked: string[] = [];
  const seen = new Set<string>([productId]);
  for (const id of [...coOccurring, ...sameCollection, ...affinity]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ranked.push(id);
  }
  if (ranked.length === 0) return [];

  // ─── Hydrate + active filter, preserving rank ─────────────
  const productRows = await loadChunked(ranked, (chunk) =>
    db
      .select({
        id: shopProducts.id,
        slug: shopProducts.slug,
        featuredMediaId: shopProducts.featuredMediaId,
      })
      .from(shopProducts)
      .where(
        and(inArray(shopProducts.id, chunk), eq(shopProducts.status, "active")),
      )
      .all(),
  );
  const byId = new Map(productRows.map((r) => [r.id, r]));
  const finalIds = ranked.filter((id) => byId.has(id)).slice(0, limit);
  if (finalIds.length === 0) return [];

  const [locRows, variantRows] = [
    await loadChunked(finalIds, (chunk) =>
      db
        .select({
          productId: shopProductLocalizations.productId,
          locale: shopProductLocalizations.locale,
          title: shopProductLocalizations.title,
        })
        .from(shopProductLocalizations)
        .where(inArray(shopProductLocalizations.productId, chunk))
        .all(),
    ),
    await loadChunked(finalIds, (chunk) =>
      db
        .select({
          productId: shopProductVariants.productId,
          priceSatang: shopProductVariants.priceSatang,
        })
        .from(shopProductVariants)
        .where(
          and(
            inArray(shopProductVariants.productId, chunk),
            eq(shopProductVariants.status, "active"),
          ),
        )
        .all(),
    ),
  ];
  const titles = new Map<string, Record<string, string>>();
  for (const row of locRows) {
    const t = titles.get(row.productId) ?? {};
    t[row.locale] = row.title;
    titles.set(row.productId, t);
  }
  const minPrice = new Map<string, number>();
  for (const row of variantRows) {
    const prev = minPrice.get(row.productId);
    if (prev === undefined || row.priceSatang < prev) {
      minPrice.set(row.productId, row.priceSatang);
    }
  }

  return finalIds.map((id) => {
    const row = byId.get(id)!;
    return {
      id,
      slug: row.slug,
      featuredMediaId: row.featuredMediaId,
      priceFromSatang: minPrice.get(id) ?? null,
      titles: titles.get(id) ?? {},
    };
  });
}
