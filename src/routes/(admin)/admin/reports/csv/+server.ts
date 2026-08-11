/**
 * GET /admin/reports/csv?from=YYYY-MM-DD&to=YYYY-MM-DD — CSV download
 * of the finance report (D5). Same guard + same aggregation module as
 * the page; exists as a sibling endpoint because a +page.server.ts
 * load cannot return an attachment Response.
 */
import { error, redirect } from "@sveltejs/kit";
import { hasRole } from "$lib/server/auth/permissions";
import {
  buildFinanceReport,
  financeReportToCsv,
  resolveReportRange,
} from "$plugins/shop/finance-report";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, platform, url }) => {
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
  const report = await buildFinanceReport(env.DB, range);
  return new Response(financeReportToCsv(report), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="finance-report-${range.from}-to-${range.to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
