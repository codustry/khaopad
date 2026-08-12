/**
 * /admin/shop/collections/[id] — collection editor.
 *
 * Before this route the collections index was a dead end: you could
 * create a collection and assign products, but there was no way to
 * reopen one. The public storefront (/[locale]/collections/[slug]) has
 * been able to render them the whole time, so admin was the only side
 * that could not manage what it created.
 *
 * The shop plugin has no `getCollection` / `updateCollection` yet
 * (only `listCollectionsForAdmin` + `createCollection`), so the reads
 * and writes are done here against the Drizzle schema directly rather
 * than growing the plugin surface from a route. Everything goes
 * through the same tables `createCollection` writes.
 */
import { error, fail, redirect } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import { hasRole } from "$lib/server/auth/permissions";
import { logAudit } from "$lib/server/audit";
import { slugify } from "$lib/utils";
import { ShopService } from "$plugins/shop/service";
import {
  shopCollectionLocalizations,
  shopCollectionProducts,
  shopCollections,
  shopProductLocalizations,
} from "$plugins/shop/schema";
import type { Actions, PageServerLoad } from "./$types";

const STATUSES = ["draft", "active", "archived"] as const;
type CollectionStatus = (typeof STATUSES)[number];

export const load: PageServerLoad = async ({ locals, platform, params }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) {
    throw error(
      403,
      "Only editors, admins and super admins can access this area.",
    );
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const db = drizzle(env.DB);
  const collection = await db
    .select()
    .from(shopCollections)
    .where(eq(shopCollections.id, params.id))
    .limit(1)
    .get();
  if (!collection) throw error(404, "Collection not found");

  const svc = new ShopService(env.DB);
  const [localizations, members, allProducts] = await Promise.all([
    db
      .select()
      .from(shopCollectionLocalizations)
      .where(eq(shopCollectionLocalizations.collectionId, params.id))
      .all(),
    db
      .select()
      .from(shopCollectionProducts)
      .where(eq(shopCollectionProducts.collectionId, params.id))
      .all(),
    // Same cap the index uses — the membership picker is a checkbox
    // list, not a paginated search.
    svc.listProducts({ limit: 200 }),
  ]);

  const byLocale: Record<
    string,
    { title: string; descriptionMarkdown: string | null }
  > = {};
  for (const l of localizations) {
    byLocale[l.locale] = {
      title: l.title,
      descriptionMarkdown: l.descriptionMarkdown,
    };
  }

  // Members may include products outside the 200 the picker loaded, so
  // resolve their titles separately rather than silently dropping them
  // from the "products in this collection" list.
  const memberIds = members.map((m) => m.productId);
  const knownIds = new Set(allProducts.map((p) => p.id));
  const missingIds = memberIds.filter((id) => !knownIds.has(id));
  const extraTitles = missingIds.length
    ? await db
        .select({
          productId: shopProductLocalizations.productId,
          locale: shopProductLocalizations.locale,
          title: shopProductLocalizations.title,
        })
        .from(shopProductLocalizations)
        .where(inArray(shopProductLocalizations.productId, missingIds))
        .all()
    : [];

  const titleById = new Map<string, string>(
    allProducts.map((p) => [p.id, p.title || p.slug]),
  );
  for (const t of extraTitles) {
    if (t.locale === "en" || !titleById.has(t.productId)) {
      titleById.set(t.productId, t.title);
    }
  }

  const products = members
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      id: m.productId,
      title: titleById.get(m.productId) ?? m.productId,
      position: m.position,
    }));

  return {
    collection,
    localizations: byLocale,
    products,
    memberIds,
    allProducts: allProducts.map((p) => ({
      id: p.id,
      title: p.title || p.slug,
      status: p.status,
    })),
  };
};

export const actions: Actions = {
  /**
   * One save action covering the collection's own fields, both
   * localizations and membership — matching the SaveBar contract, where
   * one ⌘S commits everything the form is showing.
   */
  save: async ({ request, locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "editor"))
      return fail(403, { error: "Forbidden" });
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const fd = await request.formData();
    const titleEn = String(fd.get("title_en") ?? "").trim();
    const titleTh = String(fd.get("title_th") ?? "").trim();
    const descEn = String(fd.get("description_en") ?? "").trim();
    const descTh = String(fd.get("description_th") ?? "").trim();
    const slugInput = String(fd.get("slug") ?? "").trim();
    const statusInput = String(fd.get("status") ?? "draft");
    const productIds = fd.getAll("productIds").map(String).filter(Boolean);

    // English is required for the same reason it is at create time: the
    // slug derives from it, and slugs are English-only ASCII.
    if (!titleEn) {
      return fail(400, {
        error: "English title is required — the slug is derived from it.",
      });
    }
    if (!STATUSES.includes(statusInput as CollectionStatus)) {
      return fail(400, { error: "Unknown status" });
    }
    const status = statusInput as CollectionStatus;

    const slug = slugify(slugInput || titleEn);
    if (!slug) {
      return fail(400, {
        error:
          "Could not derive a slug — slugs are English-only ASCII, so supply one explicitly.",
      });
    }

    const db = drizzle(env.DB);
    const existing = await db
      .select()
      .from(shopCollections)
      .where(eq(shopCollections.id, params.id))
      .limit(1)
      .get();
    if (!existing) return fail(404, { error: "Collection not found" });

    // Slug is UNIQUE — a collision would surface as an opaque D1
    // constraint error, so check for it and name the offender.
    if (slug !== existing.slug) {
      const clash = await db
        .select({ id: shopCollections.id })
        .from(shopCollections)
        .where(eq(shopCollections.slug, slug))
        .limit(1)
        .get();
      if (clash && clash.id !== params.id) {
        return fail(400, {
          error: `Slug “${slug}” is already used by another collection.`,
        });
      }
    }

    const now = new Date().toISOString();
    await db
      .update(shopCollections)
      .set({
        slug,
        status,
        updatedAt: now,
        // Stamp publishedAt on the first activation; keep the original
        // timestamp afterwards so "published on" stays historical.
        publishedAt:
          status === "active"
            ? (existing.publishedAt ?? now)
            : existing.publishedAt,
      })
      .where(eq(shopCollections.id, params.id));

    // Localizations: delete-then-insert on the (collectionId, locale)
    // PK. A cleared Thai title removes the row rather than storing an
    // empty string, which would render as a blank title on the
    // storefront.
    await db
      .delete(shopCollectionLocalizations)
      .where(eq(shopCollectionLocalizations.collectionId, params.id));
    const locRows = [
      {
        collectionId: params.id,
        locale: "en",
        title: titleEn,
        descriptionMarkdown: descEn || null,
      },
      ...(titleTh
        ? [
            {
              collectionId: params.id,
              locale: "th",
              title: titleTh,
              descriptionMarkdown: descTh || null,
            },
          ]
        : []),
    ];
    await db.insert(shopCollectionLocalizations).values(locRows);

    // Membership is a full replace: the form submits the complete
    // desired set, so a diff would only add failure modes.
    await db
      .delete(shopCollectionProducts)
      .where(eq(shopCollectionProducts.collectionId, params.id));
    if (productIds.length) {
      await db.insert(shopCollectionProducts).values(
        productIds.map((productId, position) => ({
          collectionId: params.id,
          productId,
          position,
        })),
      );
    }

    await logAudit(
      env.DB,
      locals.user.id,
      "shop.collection.update",
      params.id,
      {
        productCount: productIds.length,
        status,
        slug,
      },
    );

    return { success: true, message: "Collection saved" };
  },

  delete: async ({ locals, platform, params }) => {
    if (!locals.user) throw redirect(302, "/admin/login");
    if (!hasRole(locals.user, "admin")) {
      return fail(403, { error: "Only admins can delete collections." });
    }
    const env = platform?.env;
    if (!env) return fail(503, { error: "Platform not ready" });

    const db = drizzle(env.DB);
    // Localizations and membership rows are ON DELETE CASCADE, so the
    // parent delete is sufficient.
    await db.delete(shopCollections).where(eq(shopCollections.id, params.id));
    await logAudit(
      env.DB,
      locals.user.id,
      "shop.collection.delete",
      params.id,
      {},
    );
    throw redirect(303, "/admin/shop/collections");
  },
};
