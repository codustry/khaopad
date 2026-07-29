/**
 * Article ↔ product federation service.
 *
 * The differentiator for Khao Pad vs Shopify Metaobjects: articles
 * and products are in the same D1 database, so cross-references are
 * plain JOINs — no runtime Metaobject resolution dance, no headless-
 * CMS + Shopify duct tape.
 *
 * Public API:
 *   - listRefsForArticle(articleId): "which products does this article link?"
 *   - listArticlesForProduct(productId): "which articles feature this product?"
 *   - setRefs(articleId, refs): replace all refs for one article atomically
 *   - extractEmbeds(markdown): parse :::product{slug=classic-tee} inline
 *     embeds and return the slugs
 *   - hydrateProductEmbeds(d1, slugs): batch-resolve slugs to product
 *     summaries for rendering
 *
 * The `refKind='mentioned'` refs are auto-created when a product embed
 * is used in the article body — so editors don't have to double-enter
 * refs that already appear inline. Editors can override via the
 * article editor's "Related products" panel.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, asc } from "drizzle-orm";
import {
  shopArticleProductRefs,
  type ShopArticleProductRef,
} from "./schema-federation";
import {
  shopProducts,
  shopProductLocalizations,
  shopProductVariants,
} from "./schema";
import type { Satang } from "./money";

export type ProductSummary = {
  id: string;
  slug: string;
  title: string;
  priceFromSatang: Satang | null;
  vendor: string | null;
  featuredMediaId: string | null;
  inStock: boolean;
};

export type ArticleProductRef = ShopArticleProductRef & {
  product: ProductSummary | null;
};

export type ProductArticleRef = {
  articleId: string;
  refKind: "featured" | "mentioned" | "promoted";
  position: number;
  createdAt: string;
};

export type SetRefInput = {
  productId: string;
  refKind?: "featured" | "mentioned" | "promoted";
  position?: number;
};

/**
 * Load all refs an article declares — hydrated with the product
 * summary needed to render cards on the article page. Refs whose
 * product row is missing (or archived) are dropped, matching the
 * public-visibility contract.
 */
export async function listRefsForArticle(
  d1: D1Database,
  articleId: string,
): Promise<ArticleProductRef[]> {
  const db = drizzle(d1);
  const refs = await db
    .select()
    .from(shopArticleProductRefs)
    .where(eq(shopArticleProductRefs.articleId, articleId))
    .orderBy(asc(shopArticleProductRefs.position))
    .all();
  if (refs.length === 0) return [];

  const productIds = Array.from(new Set(refs.map((r) => r.productId)));
  const summaries = await hydrateProductSummaries(d1, productIds);
  const byId = new Map(summaries.map((s) => [s.id, s]));

  return refs
    .map((r) => ({
      ...r,
      product: byId.get(r.productId) ?? null,
    }))
    .filter((r) => r.product != null);
}

export async function listArticlesForProduct(
  d1: D1Database,
  productId: string,
): Promise<ProductArticleRef[]> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(shopArticleProductRefs)
    .where(eq(shopArticleProductRefs.productId, productId))
    .orderBy(asc(shopArticleProductRefs.position))
    .all();
  return rows.map((r) => ({
    articleId: r.articleId,
    refKind: r.refKind,
    position: r.position,
    createdAt: r.createdAt,
  }));
}

/**
 * Replace all refs for one article. Delete-all + re-insert semantics —
 * simpler than diffing, matches the editor's "save the whole panel"
 * workflow. Composite PK (article, product, kind) means a product
 * can appear once per kind; the same product with different kinds is
 * legal (e.g. same product both `featured` in the hero and `mentioned`
 * inline).
 */
export async function setRefs(
  d1: D1Database,
  input: {
    articleId: string;
    refs: SetRefInput[];
    createdBy?: string | null;
  },
): Promise<void> {
  const db = drizzle(d1);
  await db
    .delete(shopArticleProductRefs)
    .where(eq(shopArticleProductRefs.articleId, input.articleId));
  if (input.refs.length === 0) return;
  const now = new Date().toISOString();
  await db.insert(shopArticleProductRefs).values(
    input.refs.map((r, index) => ({
      articleId: input.articleId,
      productId: r.productId,
      refKind: r.refKind ?? "mentioned",
      position: r.position ?? index,
      createdAt: now,
      createdBy: input.createdBy ?? null,
    })),
  );
}

/**
 * Add a single ref (idempotent — upsert semantics on the composite
 * PK). Used by the auto-embed hook when :::product markdown is
 * detected in an article body.
 */
export async function addRefIfMissing(
  d1: D1Database,
  input: {
    articleId: string;
    productId: string;
    refKind?: "featured" | "mentioned" | "promoted";
    createdBy?: string | null;
  },
): Promise<void> {
  const db = drizzle(d1);
  const kind = input.refKind ?? "mentioned";
  const existing = await db
    .select()
    .from(shopArticleProductRefs)
    .where(
      and(
        eq(shopArticleProductRefs.articleId, input.articleId),
        eq(shopArticleProductRefs.productId, input.productId),
        eq(shopArticleProductRefs.refKind, kind),
      ),
    )
    .limit(1)
    .get();
  if (existing) return;
  await db.insert(shopArticleProductRefs).values({
    articleId: input.articleId,
    productId: input.productId,
    refKind: kind,
    position: 999, // auto-embeds sort last unless an editor reorders
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy ?? null,
  });
}

// ─── Markdown embed parser ──────────────────────────────────

const EMBED_PATTERN = /^:::product\{slug=([a-z0-9-]+)\}\s*$/gm;

/**
 * Extract product slugs from :::product{slug=classic-tee} embeds in
 * a markdown body. Called at save time to auto-populate refs and at
 * render time to hydrate the inline cards.
 *
 * Only matches the exact one-line syntax to keep the parser boring +
 * deterministic. Editors who want a card in the middle of a paragraph
 * should use the "Featured product" field on the article, not the
 * embed.
 */
export function extractEmbeds(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const slugs = new Set<string>();
  for (const match of markdown.matchAll(EMBED_PATTERN)) {
    if (match[1]) slugs.add(match[1]);
  }
  return Array.from(slugs);
}

/**
 * Render :::product embeds → placeholder HTML the article template
 * can replace with a live product card. Approach: leave a
 * `<div data-shop-embed="classic-tee">` in the output so the client-
 * side hydration picks it up. Server-side rendering can also
 * pre-render the card by looking up the product summary.
 *
 * For simplicity, v3.4 replaces the embed with an inline `<a>` link;
 * v3.5 upgrades to a richer card component.
 */
export function replaceEmbedsWithPlaceholders(
  markdown: string,
  productsBySlug: Map<string, ProductSummary>,
): string {
  return markdown.replace(EMBED_PATTERN, (_match, slug: string) => {
    const product = productsBySlug.get(slug);
    if (!product) {
      // Missing product — leave a warning comment for admin's
      // preview, but drop the empty embed from the public output.
      return `<!-- shop embed: product ${slug} not found -->`;
    }
    // Minimal card as HTML — matches the site's existing prose style.
    // Real component upgrade lands in v3.5.
    const priceLabel = product.priceFromSatang
      ? `<span class="text-sm text-muted-foreground">From ฿${(product.priceFromSatang / 100).toFixed(2)}</span>`
      : "";
    return `<a href="/en/products/${product.slug}" class="not-prose block rounded-lg border border-border p-4 my-4 hover:bg-muted transition-colors"><div class="font-semibold">${escapeHtml(product.title)}</div>${priceLabel}</a>`;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Batch product summary hydration ────────────────────────

/**
 * Fetch product summaries for a set of ids. Batched — one round-trip
 * for products, one for localizations (English), one for variants
 * (min price + stock rollup).
 */
async function hydrateProductSummaries(
  d1: D1Database,
  productIds: string[],
): Promise<ProductSummary[]> {
  if (productIds.length === 0) return [];
  const db = drizzle(d1);

  const [products, locs, variants] = await Promise.all([
    db
      .select()
      .from(shopProducts)
      .where(
        and(
          inArray(shopProducts.id, productIds),
          eq(shopProducts.status, "active"),
        ),
      )
      .all(),
    db
      .select()
      .from(shopProductLocalizations)
      .where(
        and(
          inArray(shopProductLocalizations.productId, productIds),
          eq(shopProductLocalizations.locale, "en"),
        ),
      )
      .all(),
    db
      .select()
      .from(shopProductVariants)
      .where(
        and(
          inArray(shopProductVariants.productId, productIds),
          eq(shopProductVariants.status, "active"),
        ),
      )
      .all(),
  ]);

  const titleByProduct = new Map(locs.map((l) => [l.productId, l.title]));
  const variantsByProduct = new Map<string, typeof variants>();
  for (const v of variants) {
    const arr = variantsByProduct.get(v.productId) ?? [];
    arr.push(v);
    variantsByProduct.set(v.productId, arr);
  }

  return products.map((p) => {
    const prodVariants = variantsByProduct.get(p.id) ?? [];
    const priceFromSatang = prodVariants.length
      ? (Math.min(...prodVariants.map((v) => v.priceSatang)) as Satang)
      : null;
    // in_stock: any variant with price>0 (we don't join inventory here
    // to keep the summary cheap — mostly used in "related products"
    // sections where a definitive stock indicator isn't critical)
    return {
      id: p.id,
      slug: p.slug,
      title: titleByProduct.get(p.id) ?? p.slug,
      priceFromSatang,
      vendor: p.vendor,
      featuredMediaId: p.featuredMediaId,
      inStock: prodVariants.length > 0,
    };
  });
}

/**
 * Batch-fetch product summaries by SLUG (rather than id) — the shape
 * needed by the markdown embed renderer, which only knows slugs.
 */
export async function hydrateProductEmbeds(
  d1: D1Database,
  slugs: string[],
): Promise<Map<string, ProductSummary>> {
  if (slugs.length === 0) return new Map();
  const db = drizzle(d1);
  const products = await db
    .select({ id: shopProducts.id })
    .from(shopProducts)
    .where(
      and(
        inArray(shopProducts.slug, slugs),
        eq(shopProducts.status, "active"),
      ),
    )
    .all();
  const summaries = await hydrateProductSummaries(
    d1,
    products.map((p) => p.id),
  );
  return new Map(summaries.map((s) => [s.slug, s]));
}
