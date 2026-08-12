/**
 * Shop CRUD service.
 *
 * Server-only. Wraps the raw Drizzle schema in a service layer that
 * owns the invariants — slug normalization, English localization
 * required, variant title cache refresh, inventory-item bookkeeping,
 * cross-table cascades that Drizzle FKs don't cover.
 *
 * Kept explicit rather than pushed into Drizzle hooks so failure
 * modes are debuggable. Every write is a single db.batch() where
 * possible (single D1 round-trip + atomic).
 */
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { slugify } from "$lib/utils";
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
  type ShopCollection,
  type ShopProduct,
} from "./schema";
import { type Satang } from "./money";
import { refreshProductIndex } from "./search";
// #165. Note the import cycle with bundles.ts (which imports
// ShopValidationError from here): benign under ESM because neither
// side touches the other's binding at module-evaluation time — the
// class is only constructed inside a thrown error, and these
// functions are only called from methods. Keeping ShopValidationError
// in service.ts preserves the import path 13 other modules already use.
import {
  bundleAvailability,
  componentValueSatang,
  getBundleComponents,
  setBundleComponents,
  type BundleComponentDetail,
  type BundleComponentInput,
} from "./bundles";

// ─── Types ──────────────────────────────────────────────────

export type LocalizedText = {
  title: string;
  descriptionMarkdown?: string | null;
};

export type ProductLocalizations = Record<string, LocalizedText>;

export type OptionInput = {
  /** Stable id — pass an existing id to update, omit for a new option. */
  id?: string;
  name: string;
  position: number;
  values: Array<{
    id?: string;
    value: string;
    sortOrder?: number;
    swatchHex?: string | null;
  }>;
};

export type VariantInput = {
  id?: string;
  sku?: string | null;
  barcode?: string | null;
  status?: "active" | "archived";
  priceSatang: Satang | number;
  compareAtSatang?: Satang | number | null;
  weightGrams?: number | null;
  requiresShipping?: boolean;
  taxable?: boolean;
  position?: number;
  mediaId?: string | null;
  /** Option value ids that identify this variant's option combination. */
  optionValueIds: string[];
  /** Initial on-hand stock. Ignored on update — use adjustInventory(). */
  initialOnHand?: number;
};

export type CreateProductInput = {
  status?: "draft" | "active" | "archived";
  vendor?: string | null;
  productType?: string | null;
  tags?: string[]; // stored as JSON string
  featuredMediaId?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  slug?: string; // if omitted, derived from localizations.en.title
  localizations: ProductLocalizations;
  options?: OptionInput[];
  variants: VariantInput[];
};

export type UpdateProductInput = Partial<
  Omit<CreateProductInput, "localizations" | "options" | "variants">
> & {
  localizations?: ProductLocalizations;
  options?: OptionInput[];
  variants?: VariantInput[];
};

export type ShopProductWithGraph = ShopProduct & {
  localizations: ProductLocalizations;
  options: Array<
    typeof shopProductOptions.$inferSelect & {
      values: Array<typeof shopProductOptionValues.$inferSelect>;
    }
  >;
  variants: Array<
    typeof shopProductVariants.$inferSelect & {
      optionValueIds: string[];
      // For a BUNDLE variant, `available` is derived from the
      // components (min over floor(available / qty)) rather than read
      // from a stock row the bundle does not have. See hydrateProduct.
      inventory: {
        onHand: number;
        reserved: number;
        available: number;
      } | null;
      /** Non-null only for bundle variants (#165). */
      bundleComponents: BundleComponentDetail[] | null;
      /**
       * What the components would cost bought separately — DISPLAY
       * ONLY ("normally 1,050฿"). The bundle's own priceSatang is the
       * authoritative price and the only one that reaches an order.
       */
      bundleComponentValueSatang: number | null;
    }
  >;
};

// ─── Errors ─────────────────────────────────────────────────

export class ShopValidationError extends Error {
  readonly code = "SHOP_VALIDATION_ERROR";
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ShopValidationError";
  }
}

// ─── Helpers ────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Compute the cached variant title from its option values. Produces
 * "Red / M" for a variant with two option values, empty string for a
 * variant with no options (default variant).
 *
 * Reads the option value labels in the order of their parent option's
 * `position` — so a "Size / Color" product produces "M / Red", not
 * "Red / M".
 */
function computeVariantTitle(
  optionValueIds: string[],
  optionValues: Map<string, { value: string; optionPosition: number }>,
): string {
  const enriched = optionValueIds
    .map((id) => optionValues.get(id))
    .filter((v): v is { value: string; optionPosition: number } => Boolean(v));
  enriched.sort((a, b) => a.optionPosition - b.optionPosition);
  return enriched.map((e) => e.value).join(" / ");
}

// ─── Service ────────────────────────────────────────────────

export class ShopService {
  private db: ReturnType<typeof drizzle>;

  constructor(private readonly d1: D1Database) {
    this.db = drizzle(d1);
  }

  // ── Products ───────────────────────────────────────────

  async listProducts(
    opts: {
      status?: "draft" | "active" | "archived";
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<
    Array<
      ShopProduct & {
        title: string;
        priceFromSatang: number | null;
        inStock: boolean;
      }
    >
  > {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    const rows = await (opts.status
      ? this.db
          .select()
          .from(shopProducts)
          .where(eq(shopProducts.status, opts.status))
          .orderBy(desc(shopProducts.updatedAt))
          .limit(limit)
          .offset(offset)
      : this.db
          .select()
          .from(shopProducts)
          .orderBy(desc(shopProducts.updatedAt))
          .limit(limit)
          .offset(offset));
    if (rows.length === 0) return [];

    const productIds = rows.map((r) => r.id);
    const locs = await this.db
      .select()
      .from(shopProductLocalizations)
      .where(inArray(shopProductLocalizations.productId, productIds))
      .all();
    const variants = await this.db
      .select()
      .from(shopProductVariants)
      .where(
        and(
          inArray(shopProductVariants.productId, productIds),
          eq(shopProductVariants.status, "active"),
        ),
      )
      .all();

    // Inventory for those variants
    const variantIds = variants.map((v) => v.id);
    const items = variantIds.length
      ? await this.db
          .select()
          .from(shopInventoryItems)
          .where(inArray(shopInventoryItems.variantId, variantIds))
          .all()
      : [];
    const itemIds = items.map((i) => i.id);
    const levels = itemIds.length
      ? await this.db
          .select()
          .from(shopInventoryLevels)
          .where(inArray(shopInventoryLevels.itemId, itemIds))
          .all()
      : [];
    const itemByVariant = new Map(items.map((i) => [i.variantId, i]));
    const levelByItem = new Map(levels.map((l) => [l.itemId, l]));

    // Group by product
    const locsByProduct = new Map<string, Map<string, LocalizedText>>();
    for (const l of locs) {
      const map = locsByProduct.get(l.productId) ?? new Map();
      map.set(l.locale, {
        title: l.title,
        descriptionMarkdown: l.descriptionMarkdown,
      });
      locsByProduct.set(l.productId, map);
    }

    const variantsByProduct = new Map<
      string,
      Array<typeof shopProductVariants.$inferSelect>
    >();
    for (const v of variants) {
      const arr = variantsByProduct.get(v.productId) ?? [];
      arr.push(v);
      variantsByProduct.set(v.productId, arr);
    }

    return rows.map((product) => {
      const locsMap = locsByProduct.get(product.id) ?? new Map();
      const title =
        (locsMap.get("en") as LocalizedText | undefined)?.title ??
        (locsMap.values().next().value as LocalizedText | undefined)?.title ??
        product.slug;
      const productVariants = variantsByProduct.get(product.id) ?? [];
      const prices = productVariants.map((v) => v.priceSatang);
      const priceFromSatang = prices.length ? Math.min(...prices) : null;
      const inStock = productVariants.some((v) => {
        const item = itemByVariant.get(v.id);
        if (!item?.tracked) return true; // untracked variants are always in stock
        if (!item) return false;
        const level = levelByItem.get(item.id);
        if (!level) return false;
        return level.onHand - level.reserved > 0;
      });
      return { ...product, title, priceFromSatang, inStock };
    });
  }

  async getProductBySlug(slug: string): Promise<ShopProductWithGraph | null> {
    const rows = await this.db
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.slug, slug))
      .limit(1)
      .all();
    const product = rows[0];
    if (!product) return null;
    return this.hydrateProduct(product);
  }

  async getProduct(id: string): Promise<ShopProductWithGraph | null> {
    const rows = await this.db
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.id, id))
      .limit(1)
      .all();
    const product = rows[0];
    if (!product) return null;
    return this.hydrateProduct(product);
  }

  private async hydrateProduct(
    product: ShopProduct,
  ): Promise<ShopProductWithGraph> {
    const [locs, options, values, variants, variantOptions, items] =
      await Promise.all([
        this.db
          .select()
          .from(shopProductLocalizations)
          .where(eq(shopProductLocalizations.productId, product.id))
          .all(),
        this.db
          .select()
          .from(shopProductOptions)
          .where(eq(shopProductOptions.productId, product.id))
          .all(),
        // option_values need a two-step (get option ids first)
        this.db
          .select()
          .from(shopProductOptions)
          .where(eq(shopProductOptions.productId, product.id))
          .all()
          .then((opts) =>
            opts.length
              ? this.db
                  .select()
                  .from(shopProductOptionValues)
                  .where(
                    inArray(
                      shopProductOptionValues.optionId,
                      opts.map((o) => o.id),
                    ),
                  )
                  .all()
              : [],
          ),
        this.db
          .select()
          .from(shopProductVariants)
          .where(eq(shopProductVariants.productId, product.id))
          .all(),
        this.db
          .select()
          .from(shopProductVariants)
          .where(eq(shopProductVariants.productId, product.id))
          .all()
          .then((vs) =>
            vs.length
              ? this.db
                  .select()
                  .from(shopProductVariantOptions)
                  .where(
                    inArray(
                      shopProductVariantOptions.variantId,
                      vs.map((v) => v.id),
                    ),
                  )
                  .all()
              : [],
          ),
        this.db
          .select()
          .from(shopProductVariants)
          .where(eq(shopProductVariants.productId, product.id))
          .all()
          .then((vs) =>
            vs.length
              ? this.db
                  .select()
                  .from(shopProductVariants)
                  .leftJoin(
                    shopInventoryItems,
                    eq(shopInventoryItems.variantId, shopProductVariants.id),
                  )
                  .leftJoin(
                    shopInventoryLevels,
                    eq(shopInventoryLevels.itemId, shopInventoryItems.id),
                  )
                  .where(
                    inArray(
                      shopProductVariants.id,
                      vs.map((v) => v.id),
                    ),
                  )
                  .all()
              : [],
          ),
      ]);

    const valuesByOption = new Map<
      string,
      Array<typeof shopProductOptionValues.$inferSelect>
    >();
    for (const val of values) {
      const arr = valuesByOption.get(val.optionId) ?? [];
      arr.push(val);
      valuesByOption.set(val.optionId, arr);
    }
    for (const [, arr] of valuesByOption) {
      arr.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    const optionsHydrated = options
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ ...o, values: valuesByOption.get(o.id) ?? [] }));

    const variantOptsByVariant = new Map<string, string[]>();
    for (const vo of variantOptions) {
      const arr = variantOptsByVariant.get(vo.variantId) ?? [];
      arr.push(vo.optionValueId);
      variantOptsByVariant.set(vo.variantId, arr);
    }

    // items is the join rows — extract inventory per variant
    type JoinRow = {
      shop_product_variants: typeof shopProductVariants.$inferSelect;
      shop_inventory_items: typeof shopInventoryItems.$inferSelect | null;
      shop_inventory_levels: typeof shopInventoryLevels.$inferSelect | null;
    };
    const inventoryByVariant = new Map<
      string,
      { onHand: number; reserved: number; available: number } | null
    >();
    for (const raw of items as unknown as JoinRow[]) {
      const variantId = raw.shop_product_variants.id;
      const level = raw.shop_inventory_levels;
      if (level) {
        inventoryByVariant.set(variantId, {
          onHand: level.onHand,
          reserved: level.reserved,
          available: level.onHand - level.reserved,
        });
      } else {
        inventoryByVariant.set(variantId, null);
      }
    }

    // Bundle components (#165). Only queried for products flagged as
    // bundles — an ordinary product pays nothing for this feature.
    //
    // A bundle variant's `inventory.available` is REPLACED by the
    // derived min-over-components figure, because the bundle itself
    // owns no stock. Every existing availability read (storefront
    // sold-out state, JSON-LD, admin table, cart checks) therefore
    // becomes bundle-correct without touching a single call site.
    // `onHand`/`reserved` are left as the raw bundle-row values (0 or
    // null) — they describe a shelf the bundle does not have.
    const bundleComponentsByVariant = new Map<
      string,
      BundleComponentDetail[]
    >();
    if (product.isBundle && variants.length > 0) {
      const perVariant = await Promise.all(
        variants.map(
          async (v) =>
            [v.id, await getBundleComponents(this.d1, v.id)] as const,
        ),
      );
      // An EMPTY list is still recorded. A bundle whose components were
      // cleared must render as sold out, not fall through to ordinary
      // variant availability — where it would read its own (absent or
      // stale) stock row and could go on sale as an empty box.
      for (const [variantId, comps] of perVariant) {
        bundleComponentsByVariant.set(variantId, comps);
      }
    }

    const variantsHydrated = variants
      .sort((a, b) => a.position - b.position)
      .map((v) => {
        const components = bundleComponentsByVariant.get(v.id) ?? null;
        const baseInventory = inventoryByVariant.get(v.id) ?? null;
        if (!components) {
          return {
            ...v,
            optionValueIds: variantOptsByVariant.get(v.id) ?? [],
            inventory: baseInventory,
            bundleComponents: null,
            bundleComponentValueSatang: null,
          };
        }
        const { available } = bundleAvailability(
          components.map((c) => ({
            componentVariantId: c.componentVariantId,
            quantity: c.quantity,
            available: c.available,
          })),
        );
        const derived =
          available === Infinity ? Number.MAX_SAFE_INTEGER : available;
        return {
          ...v,
          optionValueIds: variantOptsByVariant.get(v.id) ?? [],
          inventory: {
            onHand: baseInventory?.onHand ?? 0,
            reserved: baseInventory?.reserved ?? 0,
            available: derived,
          },
          bundleComponents: components,
          // Display-only "parts would cost this separately" figure.
          // Never a price — see componentValueSatang in bundles.ts.
          bundleComponentValueSatang: componentValueSatang(
            components.map((c) => ({
              quantity: c.quantity,
              priceSatang: c.priceSatang,
            })),
          ),
        };
      });

    const localizations: ProductLocalizations = {};
    for (const l of locs) {
      localizations[l.locale] = {
        title: l.title,
        descriptionMarkdown: l.descriptionMarkdown,
      };
    }

    return {
      ...product,
      localizations,
      options: optionsHydrated,
      variants: variantsHydrated,
    };
  }

  async createProduct(input: CreateProductInput): Promise<string> {
    // English localization required for slug derivation (Khao Pad
    // convention). If explicit slug provided, English still required
    // for admin list display.
    const en = input.localizations["en"];
    if (!en || !en.title.trim()) {
      throw new ShopValidationError(
        "English localization (locale='en') with a title is required",
        "localizations.en.title",
      );
    }
    const slug = input.slug ? slugify(input.slug) : slugify(en.title);
    if (!slug) {
      throw new ShopValidationError(
        "Could not derive a valid slug from the English title. Provide an explicit slug or use an English-ASCII title.",
        "slug",
      );
    }

    if (input.variants.length === 0) {
      throw new ShopValidationError(
        "At least one variant is required (a product with no options gets a single default variant).",
        "variants",
      );
    }

    // Pre-check slug uniqueness so callers get a nice validation error
    // instead of a D1 UNIQUE constraint 500. Race between two creates
    // for the same slug: one wins, the second hits the D1 UNIQUE at
    // insert time — the catch below rethrows as ShopValidationError.
    const existing = await this.db
      .select({ id: shopProducts.id })
      .from(shopProducts)
      .where(eq(shopProducts.slug, slug))
      .limit(1)
      .get();
    if (existing) {
      throw new ShopValidationError(
        `A product with slug "${slug}" already exists. Choose a different title or set an explicit slug.`,
        "slug",
      );
    }

    const productId = nanoid();
    const now = nowIso();
    const publishedAt = input.status === "active" ? now : null;

    // Build option/value id maps so we can insert them + reference in
    // variant_options. Callers may pass ids to update in the create
    // path (idempotency for the same-slug case) — nanoid otherwise.
    const optionIdMap = new Map<string, string>(); // input-index -> id
    const optionValueIdMap = new Map<string, string>(); // "optIdx:valIdx" -> id

    const optionInserts = (input.options ?? []).map((opt, oi) => {
      const id = opt.id ?? nanoid();
      optionIdMap.set(String(oi), id);
      return {
        id,
        productId,
        name: opt.name,
        position: opt.position,
      };
    });

    const optionValueInserts: Array<
      typeof shopProductOptionValues.$inferInsert
    > = [];
    (input.options ?? []).forEach((opt, oi) => {
      opt.values.forEach((val, vi) => {
        const id = val.id ?? nanoid();
        optionValueIdMap.set(`${oi}:${vi}`, id);
        optionValueInserts.push({
          id,
          optionId: optionIdMap.get(String(oi))!,
          value: val.value,
          sortOrder: val.sortOrder ?? vi,
          swatchHex: val.swatchHex ?? null,
        });
      });
    });

    // Build a lookup to compute titleCached
    const valueLookup = new Map<
      string,
      { value: string; optionPosition: number }
    >();
    (input.options ?? []).forEach((opt, oi) => {
      opt.values.forEach((val, vi) => {
        valueLookup.set(optionValueIdMap.get(`${oi}:${vi}`)!, {
          value: val.value,
          optionPosition: opt.position,
        });
      });
    });

    // Variants — validate option value ids first
    const variantInserts: Array<typeof shopProductVariants.$inferInsert> = [];
    const variantOptionInserts: Array<
      typeof shopProductVariantOptions.$inferInsert
    > = [];
    const inventoryItemInserts: Array<typeof shopInventoryItems.$inferInsert> =
      [];
    const inventoryLevelInserts: Array<
      typeof shopInventoryLevels.$inferInsert
    > = [];

    input.variants.forEach((v, vi) => {
      const variantId = v.id ?? nanoid();
      const titleCached = computeVariantTitle(v.optionValueIds, valueLookup);
      variantInserts.push({
        id: variantId,
        productId,
        sku: v.sku ?? null,
        barcode: v.barcode ?? null,
        status: v.status ?? "active",
        titleCached,
        priceSatang: v.priceSatang as number,
        compareAtSatang: (v.compareAtSatang as number | null) ?? null,
        weightGrams: v.weightGrams ?? null,
        requiresShipping: v.requiresShipping ?? true,
        taxable: v.taxable ?? true,
        position: v.position ?? vi + 1,
        mediaId: v.mediaId ?? null,
      });

      for (const ovId of v.optionValueIds) {
        variantOptionInserts.push({
          variantId,
          optionValueId: ovId,
        });
      }

      const itemId = nanoid();
      inventoryItemInserts.push({
        id: itemId,
        variantId,
        tracked: true,
        costSatang: null,
        continueSellingWhenOutOfStock: false,
      });
      inventoryLevelInserts.push({
        itemId,
        locationId: "default",
        onHand: v.initialOnHand ?? 0,
        reserved: 0,
      });
    });

    // Sequential inserts within a single Worker request. FK ordering:
    // products → localizations → options → option_values → variants →
    // variant_options → inventory_items → inventory_levels. If a later
    // insert fails, cascading FKs mean deleting the product row cleans
    // up everything downstream — see `deleteProduct()`. Full D1 batch
    // atomicity is a v3.2 concern (wrap in this.d1.batch() then).
    //
    // The pre-check above catches the common slug-collision case, but
    // a race between two concurrent creates for the same slug still
    // lands here — one wins, the other's INSERT trips the D1 UNIQUE
    // constraint. Catch and rethrow as ShopValidationError so the
    // caller gets a nice 400 instead of a 500 with a leaked D1 error.
    try {
      await this.db.insert(shopProducts).values({
        id: productId,
        slug,
        status: input.status ?? "draft",
        vendor: input.vendor ?? null,
        productType: input.productType ?? null,
        tags: input.tags ? JSON.stringify(input.tags) : null,
        featuredMediaId: input.featuredMediaId ?? null,
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
        createdAt: now,
        updatedAt: now,
        publishedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") && msg.includes("shop_products.slug")) {
        throw new ShopValidationError(
          `A product with slug "${slug}" already exists.`,
          "slug",
        );
      }
      throw err;
    }
    await this.db.insert(shopProductLocalizations).values(
      Object.entries(input.localizations).map(([locale, loc]) => ({
        productId,
        locale,
        title: loc.title,
        descriptionMarkdown: loc.descriptionMarkdown ?? null,
      })),
    );
    if (optionInserts.length) {
      await this.db.insert(shopProductOptions).values(optionInserts);
    }
    if (optionValueInserts.length) {
      await this.db.insert(shopProductOptionValues).values(optionValueInserts);
    }
    if (variantInserts.length) {
      await this.db.insert(shopProductVariants).values(variantInserts);
    }
    if (variantOptionInserts.length) {
      await this.db
        .insert(shopProductVariantOptions)
        .values(variantOptionInserts);
    }
    if (inventoryItemInserts.length) {
      await this.db.insert(shopInventoryItems).values(inventoryItemInserts);
    }
    if (inventoryLevelInserts.length) {
      await this.db.insert(shopInventoryLevels).values(inventoryLevelInserts);
    }

    // Best-effort FTS refresh (matches d1.ts snapshotVersion's policy:
    // a failed index write must not break the write the user cares
    // about — the next refresh self-heals via delete+reinsert).
    await refreshProductIndex(this.db, productId).catch((err) =>
      console.error("products_fts refresh failed", err),
    );

    return productId;
  }

  /**
   * Update scalar product fields (vendor, product type, SEO, tags,
   * featured media). Localizations go through `upsertLocalization()`
   * and variants through `updateVariant()` — each write path owns its
   * own invariants, and only localization writes need an FTS refresh.
   *
   * Only keys present on `fields` are written, so callers can PATCH a
   * single column without clobbering the rest.
   */
  async updateProduct(
    id: string,
    fields: {
      vendor?: string | null;
      productType?: string | null;
      seoTitle?: string | null;
      seoDescription?: string | null;
      tags?: string[] | null;
      featuredMediaId?: string | null;
      /** #165 — marks this product's variants as fixed bundles. */
      isBundle?: boolean;
    },
  ): Promise<void> {
    const existing = await this.db
      .select({ id: shopProducts.id })
      .from(shopProducts)
      .where(eq(shopProducts.id, id))
      .limit(1)
      .get();
    if (!existing) {
      throw new ShopValidationError(`Product ${id} not found`);
    }
    const set: Partial<typeof shopProducts.$inferInsert> = {
      updatedAt: nowIso(),
    };
    if ("vendor" in fields) set.vendor = fields.vendor ?? null;
    if ("productType" in fields) set.productType = fields.productType ?? null;
    if ("seoTitle" in fields) set.seoTitle = fields.seoTitle ?? null;
    if ("seoDescription" in fields)
      set.seoDescription = fields.seoDescription ?? null;
    if ("tags" in fields)
      set.tags = fields.tags?.length ? JSON.stringify(fields.tags) : null;
    if ("isBundle" in fields) set.isBundle = fields.isBundle ?? false;
    if ("featuredMediaId" in fields)
      set.featuredMediaId = fields.featuredMediaId ?? null;
    await this.db.update(shopProducts).set(set).where(eq(shopProducts.id, id));
  }

  /**
   * Replace a bundle variant's component list (#165).
   *
   * Thin pass-through to `setBundleComponents` so admin callers keep
   * talking to one service object. All the validation that matters —
   * positive quantities, no duplicates, no self-reference and above
   * all NO NESTED BUNDLES — lives in bundles.ts, which is where the
   * unit tests point.
   *
   * Deliberately does NOT touch prices: a bundle's price is set on its
   * variant like any other variant's, through updateVariant. Changing
   * the component list must never move the price, or a merchant
   * swapping a part would silently re-tag the product.
   */
  async setBundleComponents(
    bundleVariantId: string,
    components: readonly BundleComponentInput[],
  ): Promise<void> {
    await setBundleComponents(this.d1, bundleVariantId, components);
  }

  /** Hydrated component list for one bundle variant (#165). */
  async getBundleComponents(
    bundleVariantId: string,
  ): Promise<BundleComponentDetail[]> {
    return getBundleComponents(this.d1, bundleVariantId);
  }

  /**
   * Active, non-bundle variants that a merchant may pick as bundle
   * components — the admin picker's option list.
   *
   * Excludes bundle products at the source, so the picker cannot even
   * offer a choice that `setBundleComponents` would reject. Archived
   * variants are excluded too: adding one would build a bundle that
   * can never be fulfilled.
   */
  async listBundleCandidateVariants(excludeProductId?: string): Promise<
    Array<{
      variantId: string;
      variantTitle: string;
      sku: string | null;
      productId: string;
      productTitle: string;
      priceSatang: number;
      /** Current available count; null when untracked (no ceiling). */
      available: number | null;
    }>
  > {
    // Explicit projection rather than `select()` over a join: the
    // nested-by-table shape a bare join returns is easy to mis-key
    // (both tables have an `id`), and this reads as what it is.
    //
    // `productId` deliberately comes from the VARIANT side, not
    // `shopProducts.id`. Selecting two columns both named `id` in one
    // join is a footgun in any driver that flattens result rows by
    // column name (the integration harness's better-sqlite3 shim does
    // exactly that, and the second `id` silently wins). The join
    // predicate makes the two equal, so taking the non-colliding one
    // is free.
    const joined = await this.db
      .select({
        variantId: shopProductVariants.id,
        variantTitle: shopProductVariants.titleCached,
        sku: shopProductVariants.sku,
        priceSatang: shopProductVariants.priceSatang,
        productId: shopProductVariants.productId,
        productSlug: shopProducts.slug,
      })
      .from(shopProductVariants)
      .innerJoin(
        shopProducts,
        eq(shopProducts.id, shopProductVariants.productId),
      )
      .where(
        and(
          eq(shopProductVariants.status, "active"),
          eq(shopProducts.isBundle, false),
        ),
      )
      .all();

    const productIds = [...new Set(joined.map((r) => r.productId))].filter(
      (id) => id !== excludeProductId,
    );
    if (productIds.length === 0) return [];

    const locs = await this.db
      .select()
      .from(shopProductLocalizations)
      .where(
        and(
          inArray(shopProductLocalizations.productId, productIds),
          eq(shopProductLocalizations.locale, "en"),
        ),
      )
      .all();
    const titleByProduct = new Map(locs.map((l) => [l.productId, l.title]));

    // Live stock per candidate, so the picker can show the merchant
    // how many bundles a given quantity would actually yield. Untracked
    // variants map to null — "imposes no ceiling", the same reading
    // bundleAvailability uses.
    const eligible = joined.filter((r) => r.productId !== excludeProductId);
    const invItems = eligible.length
      ? await this.db
          .select()
          .from(shopInventoryItems)
          .where(
            inArray(
              shopInventoryItems.variantId,
              eligible.map((r) => r.variantId),
            ),
          )
          .all()
      : [];
    const trackedItems = invItems.filter((i) => i.tracked);
    const invLevels = trackedItems.length
      ? await this.db
          .select()
          .from(shopInventoryLevels)
          .where(
            inArray(
              shopInventoryLevels.itemId,
              trackedItems.map((i) => i.id),
            ),
          )
          .all()
      : [];
    const levelByItemId = new Map(invLevels.map((l) => [l.itemId, l]));
    const availableByVariant = new Map<string, number>();
    for (const item of trackedItems) {
      const level = levelByItemId.get(item.id);
      if (!level) continue;
      availableByVariant.set(
        item.variantId,
        Math.max(0, level.onHand - level.reserved),
      );
    }

    return eligible
      .map((r) => ({
        variantId: r.variantId,
        variantTitle: r.variantTitle,
        sku: r.sku,
        productId: r.productId,
        productTitle: titleByProduct.get(r.productId) ?? r.productSlug,
        priceSatang: r.priceSatang,
        available: availableByVariant.get(r.variantId) ?? null,
      }))
      .sort(
        (a, b) =>
          a.productTitle.localeCompare(b.productTitle) ||
          a.variantTitle.localeCompare(b.variantTitle),
      );
  }

  /**
   * Insert-or-update one locale's title/description for a product.
   *
   * Invariants owned here:
   *   - the English localization can never lose its title (slugs and
   *     admin list display derive from it);
   *   - clearing a non-English title REMOVES that localization row
   *     (an empty-title row would render as a blank storefront page);
   *   - `products_fts` is refreshed after every write — the A3 hazard:
   *     without the refresh an edited title keeps serving the STALE
   *     search index entry, so search finds the old name forever.
   */
  async upsertLocalization(
    productId: string,
    locale: string,
    loc: LocalizedText,
  ): Promise<void> {
    const title = loc.title.trim();
    if (locale === "en" && !title) {
      throw new ShopValidationError(
        "The English title is required and cannot be removed",
        "localizations.en.title",
      );
    }
    if (!title) {
      await this.db
        .delete(shopProductLocalizations)
        .where(
          and(
            eq(shopProductLocalizations.productId, productId),
            eq(shopProductLocalizations.locale, locale),
          ),
        );
    } else {
      await this.db
        .insert(shopProductLocalizations)
        .values({
          productId,
          locale,
          title,
          descriptionMarkdown: loc.descriptionMarkdown || null,
        })
        .onConflictDoUpdate({
          target: [
            shopProductLocalizations.productId,
            shopProductLocalizations.locale,
          ],
          set: {
            title,
            descriptionMarkdown: loc.descriptionMarkdown || null,
          },
        });
    }
    await this.db
      .update(shopProducts)
      .set({ updatedAt: nowIso() })
      .where(eq(shopProducts.id, productId));
    // NOT best-effort here, unlike createProduct: an editor renaming a
    // product with a silently stale index is exactly the bug this
    // method exists to prevent, and the caller (an admin form action)
    // can surface the failure.
    await refreshProductIndex(this.db, productId);
  }

  /**
   * Update a variant's price / compare-at / SKU. No FTS refresh —
   * the index only holds localization text.
   */
  async updateVariant(
    variantId: string,
    fields: {
      priceSatang?: Satang | number;
      compareAtSatang?: Satang | number | null;
      sku?: string | null;
    },
  ): Promise<void> {
    const variant = await this.db
      .select({
        id: shopProductVariants.id,
        productId: shopProductVariants.productId,
      })
      .from(shopProductVariants)
      .where(eq(shopProductVariants.id, variantId))
      .limit(1)
      .get();
    if (!variant) {
      throw new ShopValidationError(`Variant ${variantId} not found`);
    }
    const set: Partial<typeof shopProductVariants.$inferInsert> = {};
    if ("priceSatang" in fields && fields.priceSatang !== undefined) {
      const price = Number(fields.priceSatang);
      if (!Number.isInteger(price) || price <= 0) {
        throw new ShopValidationError(
          "Price must be a positive amount",
          "priceSatang",
        );
      }
      set.priceSatang = price;
    }
    if ("compareAtSatang" in fields) {
      const compareAt =
        fields.compareAtSatang == null ? null : Number(fields.compareAtSatang);
      if (
        compareAt !== null &&
        (!Number.isInteger(compareAt) || compareAt <= 0)
      ) {
        throw new ShopValidationError(
          "Compare-at price must be a positive amount",
          "compareAtSatang",
        );
      }
      set.compareAtSatang = compareAt;
    }
    if ("sku" in fields) set.sku = fields.sku?.trim() || null;
    if (Object.keys(set).length === 0) return;
    try {
      await this.db
        .update(shopProductVariants)
        .set(set)
        .where(eq(shopProductVariants.id, variantId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") && msg.includes("sku")) {
        throw new ShopValidationError(
          `SKU "${set.sku}" is already used by another variant.`,
          "sku",
        );
      }
      throw err;
    }
    await this.db
      .update(shopProducts)
      .set({ updatedAt: nowIso() })
      .where(eq(shopProducts.id, variant.productId));
  }

  async updateProductStatus(
    id: string,
    status: "draft" | "active" | "archived",
  ): Promise<void> {
    const now = nowIso();
    const publishedAt = status === "active" ? now : null;
    await this.db
      .update(shopProducts)
      .set({ status, updatedAt: now, publishedAt })
      .where(eq(shopProducts.id, id));
  }

  async deleteProduct(id: string): Promise<void> {
    // FK cascades handle everything downstream (localizations, options,
    // variants, variant_options, inventory items+levels).
    await this.db.delete(shopProducts).where(eq(shopProducts.id, id));
    // FTS is not FK-linked — refresh drops the deleted product's rows
    // (the reinsert half finds nothing). Best-effort, see createProduct.
    await refreshProductIndex(this.db, id).catch((err) =>
      console.error("products_fts refresh failed", err),
    );
  }

  // ── Inventory ──────────────────────────────────────────

  /**
   * Adjust the on-hand count for a variant. Positive delta = stock in,
   * negative = stock out (e.g. spoilage, damage — not fulfilled orders,
   * which run through the reservation flow in v3.2).
   *
   * Guards against dropping on_hand below 0 (rejects the write).
   */
  async adjustInventory(
    variantId: string,
    delta: number,
  ): Promise<{ onHand: number; reserved: number }> {
    const item = await this.db
      .select()
      .from(shopInventoryItems)
      .where(eq(shopInventoryItems.variantId, variantId))
      .limit(1)
      .get();
    if (!item) {
      throw new ShopValidationError(
        `No inventory item for variant ${variantId}`,
      );
    }
    const level = await this.db
      .select()
      .from(shopInventoryLevels)
      .where(
        and(
          eq(shopInventoryLevels.itemId, item.id),
          eq(shopInventoryLevels.locationId, "default"),
        ),
      )
      .limit(1)
      .get();
    if (!level) {
      throw new ShopValidationError(
        `No inventory level for variant ${variantId} at default location`,
      );
    }
    const newOnHand = level.onHand + delta;
    if (newOnHand < 0) {
      throw new ShopValidationError(
        `Adjustment would drop on_hand below zero (currently ${level.onHand}, delta ${delta})`,
      );
    }
    await this.db
      .update(shopInventoryLevels)
      .set({ onHand: newOnHand })
      .where(
        and(
          eq(shopInventoryLevels.itemId, item.id),
          eq(shopInventoryLevels.locationId, "default"),
        ),
      );
    return { onHand: newOnHand, reserved: level.reserved };
  }

  // ── Collections ────────────────────────────────────────

  async listCollections(): Promise<ShopCollection[]> {
    return this.db
      .select()
      .from(shopCollections)
      .orderBy(desc(shopCollections.updatedAt))
      .all();
  }

  /**
   * Collections with their localized title and product count, for the
   * admin list view.
   *
   * `listCollections` returns bare rows, which are not renderable on
   * their own — the title lives in `shop_collection_localizations` and
   * the count in `shop_collection_products`. Both are fetched in ONE
   * query each and joined in memory rather than per-row, so the page
   * costs 3 queries regardless of how many collections exist.
   */
  async listCollectionsForAdmin(locale = "en"): Promise<
    Array<
      ShopCollection & {
        title: string;
        productCount: number;
      }
    >
  > {
    const rows = await this.listCollections();
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);

    // D1 binds at most 100 parameters per statement (see MAX_BIND_PARAMS
    // in the content query engine, which solves the same problem). A bare
    // `inArray(ids)` silently breaks the page at 101 collections, so
    // chunk it.
    const CHUNK = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      chunks.push(ids.slice(i, i + CHUNK));
    }

    const [locGroups, linkGroups] = await Promise.all([
      Promise.all(
        chunks.map((c) =>
          this.db
            .select()
            .from(shopCollectionLocalizations)
            .where(inArray(shopCollectionLocalizations.collectionId, c))
            .all(),
        ),
      ),
      Promise.all(
        chunks.map((c) =>
          this.db
            .select()
            .from(shopCollectionProducts)
            .where(inArray(shopCollectionProducts.collectionId, c))
            .all(),
        ),
      ),
    ]);
    const locs = locGroups.flat();
    const links = linkGroups.flat();

    // Prefer the requested locale, fall back to English, then anything —
    // a collection with only a Thai title should still show a title
    // rather than an empty cell.
    // Index once rather than filtering the full array per row — that was
    // O(collections x localizations), which is fine at 5 and not at 500.
    const byCollection = new Map<string, typeof locs>();
    for (const l of locs) {
      const list = byCollection.get(l.collectionId);
      if (list) list.push(l);
      else byCollection.set(l.collectionId, [l]);
    }
    const titleFor = (id: string) => {
      const forId = byCollection.get(id) ?? [];
      return (
        forId.find((l) => l.locale === locale)?.title ??
        forId.find((l) => l.locale === "en")?.title ??
        forId[0]?.title ??
        ""
      );
    };
    const counts = new Map<string, number>();
    for (const l of links) {
      counts.set(l.collectionId, (counts.get(l.collectionId) ?? 0) + 1);
    }

    return rows.map((r) => ({
      ...r,
      title: titleFor(r.id),
      productCount: counts.get(r.id) ?? 0,
    }));
  }

  async createCollection(input: {
    slug?: string;
    status?: "draft" | "active" | "archived";
    kind?: "manual" | "smart";
    rulesJson?: string | null;
    featuredMediaId?: string | null;
    seoTitle?: string | null;
    seoDescription?: string | null;
    localizations: Record<
      string,
      { title: string; descriptionMarkdown?: string | null }
    >;
    productIds?: string[];
  }): Promise<string> {
    const en = input.localizations["en"];
    if (!en || !en.title.trim()) {
      throw new ShopValidationError(
        "English localization required",
        "localizations.en.title",
      );
    }
    const slug = input.slug ? slugify(input.slug) : slugify(en.title);
    if (!slug) {
      throw new ShopValidationError(
        "Could not derive slug from English title.",
        "slug",
      );
    }
    const id = nanoid();
    const now = nowIso();
    await this.db.insert(shopCollections).values({
      id,
      slug,
      status: input.status ?? "draft",
      kind: input.kind ?? "manual",
      rulesJson: input.rulesJson ?? null,
      featuredMediaId: input.featuredMediaId ?? null,
      seoTitle: input.seoTitle ?? null,
      seoDescription: input.seoDescription ?? null,
      createdAt: now,
      updatedAt: now,
      publishedAt: input.status === "active" ? now : null,
    });
    for (const [locale, loc] of Object.entries(input.localizations)) {
      await this.db.insert(shopCollectionLocalizations).values({
        collectionId: id,
        locale,
        title: loc.title,
        descriptionMarkdown: loc.descriptionMarkdown ?? null,
      });
    }
    if (input.productIds?.length) {
      const rows = input.productIds.map((productId, position) => ({
        collectionId: id,
        productId,
        position,
      }));
      await this.db.insert(shopCollectionProducts).values(rows);
    }
    return id;
  }
}
