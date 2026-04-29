import type { Locale } from "$lib/server/content/types";

/**
 * Per-page SEO record. Every public page's `+page.server.ts` should
 * return a `seo: PageSeo` field; the layout's <Seo /> component reads
 * it via `$app/state` page.data and renders the corresponding tags.
 *
 * Designed to be cheap to construct: any field can be omitted, the
 * component falls back to sensible site-wide defaults.
 */
export type PageSeo = {
  /** Title tag. Falls back to siteName. */
  title?: string;
  /** Meta description. ~70–160 chars is the sweet spot. */
  description?: string;
  /** Canonical absolute URL of this page. */
  canonical?: string;
  /** Locale of THIS page's content. */
  locale?: Locale;
  /**
   * Per-locale alternates for hreflang. Map `locale → absolute URL`.
   * If empty, the component skips the alternate links entirely.
   */
  alternates?: Partial<Record<Locale, string>>;
  /** OG image absolute URL (1200×630 ideal). */
  image?: string;
  /** og:type. Defaults to "website" for index pages, "article" for posts. */
  ogType?: "website" | "article";
  /** ISO datetime — only meaningful for ogType="article". */
  publishedTime?: string;
  /** ISO datetime — only meaningful for ogType="article". */
  modifiedTime?: string;
  /** Robots directive. Default is index,follow (omit the meta entirely). */
  robots?: "index,follow" | "noindex,nofollow" | "noindex,follow";
  /**
   * Pre-built JSON-LD object(s) — Article, BreadcrumbList, etc.
   * Each entry is rendered as a separate <script type="application/ld+json"> tag.
   */
  jsonLd?: Array<Record<string, unknown>>;
};

/**
 * Resolve the absolute origin of the current request — necessary for
 * canonical and OG-image URLs (search engines reject relative paths).
 *
 * Reads `event.url.origin` directly. The hosts header is trusted in
 * the Cloudflare Workers environment; if you proxy behind something
 * else, override via the `cdnBaseUrl` setting at render time.
 */
export function resolveOrigin(url: URL, cdnBaseUrl?: string | null): string {
  if (cdnBaseUrl && cdnBaseUrl.startsWith("http")) {
    return cdnBaseUrl.replace(/\/+$/, "");
  }
  return url.origin;
}

/** Build the canonical URL for a path-only string. */
export function canonicalUrl(origin: string, pathname: string): string {
  return `${origin.replace(/\/+$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

/**
 * Build a JSON-LD `Article` schema for a blog post. Search engines
 * use this for rich-result eligibility (date, author, image).
 */
export function articleJsonLd(input: {
  url: string;
  headline: string;
  description?: string;
  datePublished: string;
  dateModified?: string;
  authorName: string;
  image?: string;
  publisherName: string;
  publisherLogo?: string;
}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    author: { "@type": "Person", name: input.authorName },
    publisher: {
      "@type": "Organization",
      name: input.publisherName,
      ...(input.publisherLogo && {
        logo: { "@type": "ImageObject", url: input.publisherLogo },
      }),
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
  };
  if (input.description) ld.description = input.description;
  if (input.image) ld.image = input.image;
  return ld;
}

/** Build a JSON-LD `BreadcrumbList` schema for nested pages. */
export function breadcrumbJsonLd(
  items: Array<{ name: string; url: string }>,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/** Build the site-wide `WebSite` schema (good for SearchAction). */
export function websiteJsonLd(input: {
  url: string;
  name: string;
  description?: string;
  /** If set, emits a SearchAction pointing at this URL with `{search_term_string}` placeholder. */
  searchUrl?: string;
}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    url: input.url,
    name: input.name,
  };
  if (input.description) ld.description = input.description;
  if (input.searchUrl) {
    ld.potentialAction = {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: input.searchUrl },
      "query-input": "required name=search_term_string",
    };
  }
  return ld;
}
