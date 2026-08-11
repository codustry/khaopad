/**
 * /admin/reports — finance report (D5).
 *
 * Admin+ only (same bar as orders/discounts — this is money data).
 * Date-range picker via ?from=YYYY-MM-DD&to=YYYY-MM-DD, defaulting to
 * the current month (UTC). Aggregation lives in
 * $plugins/shop/finance-report.ts; the CSV export at
 * /admin/reports/csv shares it (a +page.server load cannot return an
 * attachment Response, hence the sibling endpoint rather than an
 * action).
 *
 * Header shows the merchant's legal name + tax id from site settings —
 * ใบกำกับภาษี groundwork. The full per-order tax-invoice document is
 * explicitly deferred.
 */
import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import {
  buildFinanceReport,
  resolveReportRange,
} from "$plugins/shop/finance-report";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, platform, url }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "admin")) {
    throw error(403, "Only admins and super admins can access this area.");
  }
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  const range = resolveReportRange(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );
  const [report, settings] = await Promise.all([
    buildFinanceReport(env.DB, range),
    locals.content.getSettings(),
  ]);

  return {
    report,
    merchant: {
      legalName: (settings.merchantLegalName as string | undefined) ?? "",
      taxId: (settings.merchantTaxId as string | undefined) ?? "",
    },
  };
};
