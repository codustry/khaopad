/**
 * Route guard for the whole /admin/shop/* subtree (#193).
 *
 * A layout load covers every descendant page in one place — products,
 * collections, orders, discounts, and anything the shop plugin adds
 * later — so a new shop route cannot forget the gate.
 *
 * Hiding the nav is not enough on its own: the bug report is about an
 * empty Products list reading as broken data, and a bookmark, a browser
 * history entry, or a guessed URL reaches that list without ever
 * touching the sidebar. `requirePluginEnabled` 404s instead.
 *
 * Note this guards the ADMIN surface only. The public storefront
 * (/[locale]/products, cart, checkout) is deliberately untouched here —
 * see the PR discussion.
 */
import { requirePluginEnabled } from "$lib/server/plugins/enabled";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  await requirePluginEnabled(locals.content, "shop");
  return {};
};
