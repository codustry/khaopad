/**
 * /[locale]/careers — public job openings, sourced from an external ATS.
 *
 * See `src/plugins/careers/README.md` for configuration.
 *
 * Three properties this loader is built around:
 *
 * 1. **Server-side only.** The feed is fetched here, never from the
 *    browser: the page is fully rendered in the SSR payload so it is
 *    crawlable, and no visitor's IP ever touches the ATS.
 *
 * 2. **Never 500s on an ATS outage.** `loadCareersFeed` cannot reject;
 *    it degrades through cached → stale → empty. A recruiting page
 *    going down because a third-party API blipped is the exact failure
 *    this route exists to prevent. The only `error()` thrown here is
 *    the deliberate 404 for an unconfigured install.
 *
 * 3. **Untrusted input.** Everything in `data.jobs` has been through
 *    `normalizeFeed`, which drops malformed entries and scheme-checks
 *    every `apply_url`. The component renders it as text only.
 */
import { error } from "@sveltejs/kit";
import { toLocale, SUPPORTED_LOCALES } from "$lib/i18n";
import { canonicalUrl, resolveOrigin, type PageSeo } from "$lib/seo";
import type { Locale } from "$lib/server/content/types";
import {
  collectCategories,
  filterByCategory,
  type CareersJob,
} from "$plugins/careers/feed";
import { buildCareersJsonLd } from "$plugins/careers/jsonld";
import { loadCareersFeed, resolveFeedUrl } from "$plugins/careers/service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({
  locals,
  params,
  url,
  platform,
}) => {
  const locale = toLocale(params.locale);
  const env = platform?.env;

  // Unconfigured install → the feature does not exist. A 404 (rather
  // than an empty page) keeps an unrelated site from publishing, and
  // search engines from indexing, a careers page it never opted into.
  const feedUrl = resolveFeedUrl(env);
  if (!feedUrl) throw error(404, "Not found");

  const result = await loadCareersFeed({
    feedUrl,
    kv: env?.CONTENT_CACHE ?? null,
  });

  const settings = await locals.content.getSettings().catch(() => null);
  const siteName = settings?.siteName ?? "Khao Pad";
  const organizationName = result.feed.company ?? siteName;

  const allJobs: CareersJob[] = result.feed.jobs;
  const categories = collectCategories(allJobs);

  // Category filter lives in the query string so a filtered view is
  // shareable. An unknown slug yields zero results rather than
  // silently showing everything — a link promising "Engineering roles"
  // must not quietly render Sales.
  const requestedCategory = url.searchParams.get("category")?.trim() || null;
  const activeCategory =
    requestedCategory && categories.some((c) => c.slug === requestedCategory)
      ? requestedCategory
      : null;
  const jobs = filterByCategory(allJobs, activeCategory);

  const origin = resolveOrigin(
    url,
    env?.PUBLIC_SITE_URL || settings?.cdnBaseUrl,
  );
  const canonical = canonicalUrl(origin, `/${locale}/careers`);
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    alternates[l] = canonicalUrl(origin, `/${l}/careers`);
  }

  // JSON-LD covers the openings actually rendered. A filtered view is
  // a permutation of the index, so it is noindex,follow — the same
  // policy the shop uses for facet URLs.
  const seo: PageSeo = {
    title: `${siteName} — Careers`,
    description:
      jobs.length > 0
        ? `Open positions at ${organizationName}. ${jobs.length} role${jobs.length === 1 ? "" : "s"} currently accepting applications.`
        : `Open positions at ${organizationName}.`,
    canonical,
    locale,
    alternates,
    ogType: "website",
    robots: activeCategory ? "noindex,follow" : undefined,
    jsonLd: buildCareersJsonLd(jobs, {
      siteOrigin: origin,
      organizationName,
      listingUrl: canonical,
    }),
  };

  return {
    locale,
    jobs,
    categories,
    activeCategory,
    organizationName,
    /**
     * Exposed for the template's degraded-mode note. "stale" and
     * "unavailable" both mean the ATS did not answer this request.
     */
    feedStatus: result.status,
    seo,
  };
};
