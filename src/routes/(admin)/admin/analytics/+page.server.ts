import { redirect, error } from "@sveltejs/kit";
import { AnalyticsService } from "$lib/server/analytics";
import { hasRole } from "$lib/server/auth/permissions";
import type { PageServerLoad } from "./$types";

const WINDOW_DAYS = 30;
const TOP_LIMIT = 10;

/**
 * Visitor sources — where the site's traffic comes from.
 *
 * Editor+ rather than admin-only: knowing which campaign or search
 * engine brought readers to an article is editorial information, and
 * the underlying table holds no personal data to protect. Authors are
 * excluded so the sidebar stays short for people who only write.
 *
 * All five reads are GROUP BYs over one bounded counter table, so this
 * page cannot become slow the way an events-table scan would.
 */
export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(302, "/admin/login");
  if (!hasRole(locals.user, "editor")) throw error(403, "Forbidden");
  if (!platform?.env?.DB) throw error(503, "Platform not configured");

  const svc = new AnalyticsService(platform.env.DB);
  const [byChannel, topSources, topCampaigns, topLandingPages, series] =
    await Promise.all([
      svc.sourcesByChannel(WINDOW_DAYS),
      svc.topSources(WINDOW_DAYS, TOP_LIMIT),
      svc.topCampaigns(WINDOW_DAYS, TOP_LIMIT),
      svc.topLandingPages(WINDOW_DAYS, TOP_LIMIT),
      svc.channelSeries(WINDOW_DAYS),
    ]);

  return {
    windowDays: WINDOW_DAYS,
    byChannel,
    topSources,
    topCampaigns,
    topLandingPages,
    series,
    total: byChannel.reduce((a, r) => a + r.total, 0),
  };
};
