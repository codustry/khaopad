/**
 * Route guard for /admin/reports (#193).
 *
 * The finance report is shop-owned even though it sits in the core
 * "main" nav group — it aggregates shop_orders. Its own layout, rather
 * than a line in +page.server.ts, so the CSV sibling and any future
 * report page inherit the gate.
 *
 * (The CSV endpoint at /admin/reports/csv is a +server.ts, which layout
 * loads do NOT run for — it carries the guard inline.)
 */
import { requirePluginEnabled } from "$lib/server/plugins/enabled";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
  await requirePluginEnabled(locals.content, "shop");
  return {};
};
