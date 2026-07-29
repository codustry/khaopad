/**
 * GET /api/public/shop/collections — public collection list.
 *
 * Returns active collections with title (locale-fallback: en) and
 * product count. Detail per collection lives at
 * /api/public/shop/collections/[slug].
 */
import { error, json } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq, inArray, count } from "drizzle-orm";
import { toLocale } from "$lib/i18n";
import {
  shopCollectionLocalizations,
  shopCollectionProducts,
  shopCollections,
} from "$plugins/shop/schema";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ platform, url }) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const db = drizzle(env.DB);

  const locale = toLocale(url.searchParams.get("locale") ?? "en");

  const collections = await db
    .select()
    .from(shopCollections)
    .where(eq(shopCollections.status, "active"))
    .all();

  if (collections.length === 0) {
    return json({ collections: [] });
  }

  const ids = collections.map((c) => c.id);
  const locs = await db
    .select()
    .from(shopCollectionLocalizations)
    .where(inArray(shopCollectionLocalizations.collectionId, ids))
    .all();
  const counts = await db
    .select({
      collectionId: shopCollectionProducts.collectionId,
      total: count(),
    })
    .from(shopCollectionProducts)
    .where(inArray(shopCollectionProducts.collectionId, ids))
    .groupBy(shopCollectionProducts.collectionId)
    .all();

  const locsByCollection = new Map<string, Map<string, { title: string }>>();
  for (const l of locs) {
    const map = locsByCollection.get(l.collectionId) ?? new Map();
    map.set(l.locale, { title: l.title });
    locsByCollection.set(l.collectionId, map);
  }
  const countByCollection = new Map(
    counts.map((c) => [c.collectionId, c.total]),
  );

  return json(
    {
      collections: collections.map((c) => {
        const locsMap = locsByCollection.get(c.id) ?? new Map();
        const title =
          locsMap.get(locale)?.title ?? locsMap.get("en")?.title ?? c.slug;
        return {
          slug: c.slug,
          title,
          kind: c.kind,
          productCount: countByCollection.get(c.id) ?? 0,
          publishedAt: c.publishedAt,
        };
      }),
    },
    {
      headers: {
        "cache-control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
      },
    },
  );
};
