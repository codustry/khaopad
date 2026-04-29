import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { SUPPORTED_LOCALES } from "$lib/i18n";
import type { Locale } from "$lib/server/content/types";
import {
  canonicalUrl,
  resolveOrigin,
  websiteJsonLd,
  type PageSeo,
} from "$lib/seo";

export const load: PageServerLoad = async ({ params, url, locals }) => {
  if (!SUPPORTED_LOCALES.includes(params.locale as Locale)) {
    error(404, "Not found");
  }
  const locale = params.locale as Locale;
  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);
  const canonical = canonicalUrl(origin, `/${locale}`);
  const alternates: Partial<Record<Locale, string>> = {};
  for (const l of SUPPORTED_LOCALES) {
    alternates[l] = canonicalUrl(origin, `/${l}`);
  }

  const siteName = settings?.siteName ?? "Khao Pad";
  const seo: PageSeo = {
    title: siteName,
    canonical,
    locale,
    alternates,
    ogType: "website",
    jsonLd: [
      websiteJsonLd({
        url: canonical,
        name: siteName,
        searchUrl: `${origin}/${locale}/blog?q={search_term_string}`,
      }),
    ],
  };

  return {
    locale,
    seo,
  };
};
