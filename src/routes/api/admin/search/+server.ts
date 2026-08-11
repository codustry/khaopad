/**
 * GET /api/admin/search?q= — ⌘K content search (#160 C7).
 *
 * Signed-in editor+ only. (No surface gate — `/api/*` is shared
 * between surfaces under path-prefix routing; the auth check is the
 * real gate, same as /api/media.)
 *
 * Groups mirror the palette's role gating, enforced HERE as well as
 * client-side: orders are admin+ (the orders route itself is admin+),
 * products and articles are editor+. Each group is capped at 5 —
 * the palette is a jump-to box, not a results page.
 *
 * PII: order hits expose the buyer email and nothing else. Response
 * shapes are pinned by tests.
 */
import { error, json } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import { hasRole } from "$lib/server/auth/permissions";
import {
  searchAdminOrders,
  searchAdminProducts,
} from "$lib/server/admin/search";
import type { RequestHandler } from "./$types";

const GROUP_LIMIT = 5;

export const GET: RequestHandler = async ({ url, locals, platform }) => {
  if (!locals.user) throw error(401, "Not authenticated");
  if (!hasRole(locals.user, "editor")) throw error(403, "Forbidden");

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return json({ orders: [], products: [], articles: [] });
  }

  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  const db = drizzle(env.DB);

  const [orders, products, articleHits] = await Promise.all([
    hasRole(locals.user, "admin")
      ? searchAdminOrders(db, q, GROUP_LIMIT)
      : Promise.resolve([]),
    searchAdminProducts(db, q, GROUP_LIMIT),
    // Best-effort: searchArticles passes advanced-looking queries
    // (quotes, parens) straight to FTS5, whose parser throws on
    // malformed syntax — a typo in the palette must not 500.
    locals.content.searchArticles(q, { limit: GROUP_LIMIT }).catch(() => []),
  ]);

  // searchArticles returns one hit per (article, locale) — de-dupe by
  // article so the palette never shows the same row twice. Only id +
  // title leave the server; the snippet is body text the palette
  // doesn't render.
  const seen = new Set<string>();
  const articles: Array<{ id: string; title: string }> = [];
  for (const hit of articleHits) {
    if (seen.has(hit.articleId)) continue;
    seen.add(hit.articleId);
    articles.push({ id: hit.articleId, title: hit.title });
    if (articles.length >= GROUP_LIMIT) break;
  }

  return json({ orders, products, articles });
};
