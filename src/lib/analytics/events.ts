/**
 * Typed event catalog — the 14 canonical events from #58 spec.
 *
 * Every `track()` call is validated against this catalog at type
 * time: unknown names error, missing required properties error.
 * Plugins that need extra events (e.g. shop's `refund`, `subscribe`)
 * declare them here — the file is the source of truth for what the
 * analytics UI knows how to render.
 *
 * Client-safe: no server-only imports. `track()` is available in
 * both the browser (via a `+page.svelte` script) and the server
 * (via `+page.server.ts` load functions / actions).
 */

/**
 * Automatic context added to every event server-side, so `track()`
 * callers only supply event-specific properties.
 */
export type EventContext = {
  /** Full URL path with query string. Set from the request. */
  path: string;
  /** ISO datetime — set by the server when the event lands. */
  ts: string;
  /** Session id from the shop cart cookie or a dedicated analytics cookie. */
  sessionId: string;
  /** Populated for signed-in visitors. */
  userId?: string | null;
  /** Two-letter locale (`en`/`th`), set from the request path. */
  locale: string;
  /** Referrer header at request time (browser-provided). */
  referrer?: string | null;
  /** Extracted `utm_*` params from the URL (all lowercase). */
  utm?: Partial<
    Record<"source" | "medium" | "campaign" | "term" | "content", string>
  >;
  /** User-Agent, kept short (256 chars). */
  userAgent?: string | null;
  /** ISO-3166 alpha-2 country from Cloudflare's `cf-ipcountry` header. */
  country?: string | null;
};

/**
 * Every event in the canonical catalog. Adding a new event means:
 *   1. Add a discriminated-union member here.
 *   2. Add its display metadata to `EVENT_METADATA` below (label + icon-hint).
 * That's it — the storage layer stores the JSON blob as-is; the
 * analytics UI reads EVENT_METADATA for rendering.
 */
export type CanonicalEvent =
  // ── Page + content ─────────────────────────────
  | {
      name: "page_view";
      properties: {
        title?: string;
        articleId?: string;
        productId?: string;
        categoryId?: string;
      };
    }
  | {
      name: "article_read";
      properties: {
        articleId: string;
        readTimeMs: number;
        scrollPct: number;
      };
    }
  | {
      name: "search";
      properties: {
        query: string;
        resultsCount: number;
      };
    }
  | {
      name: "cta_click";
      properties: {
        ctaId: string;
        ctaLabel?: string;
        destination?: string;
      };
    }
  // ── Shop funnel (fires from @khaopad/plugin-shop) ─────────────────
  | {
      name: "product_view";
      properties: {
        productId: string;
        variantId?: string;
        priceSatang: number;
      };
    }
  | {
      name: "add_to_cart";
      properties: {
        productId: string;
        variantId: string;
        quantity: number;
        priceSatang: number;
      };
    }
  | {
      name: "remove_from_cart";
      properties: {
        productId: string;
        variantId: string;
        quantity: number;
      };
    }
  | {
      name: "begin_checkout";
      properties: {
        cartId: string;
        itemCount: number;
        subtotalSatang: number;
      };
    }
  | {
      name: "add_payment_info";
      properties: {
        cartId: string;
        method: string;
      };
    }
  | {
      name: "purchase";
      properties: {
        orderId: string;
        orderNumber: string;
        totalSatang: number;
        itemCount: number;
        discountCode?: string;
        /**
         * Article id that referred the visitor to the product page. Populated
         * when document.referrer matches a `/[locale]/articles/[slug]` URL,
         * enabling article → purchase attribution funnels.
         */
        attributedArticleId?: string;
      };
    }
  | {
      name: "refund";
      properties: {
        orderId: string;
        amountSatang: number;
        kind: "full" | "partial";
      };
    }
  // ── Engagement ────────────────────────────────
  | {
      name: "subscribe";
      properties: {
        formId: string;
        source?: string;
      };
    }
  | {
      name: "form_submit";
      properties: {
        formId: string;
        fields: string[];
      };
    }
  | {
      name: "comment_submit";
      properties: {
        articleId: string;
        parentId?: string;
      };
    };

/** Type helper: the name of every canonical event. */
export type CanonicalEventName = CanonicalEvent["name"];

/** Look up the properties type for a given event name. */
export type EventProperties<N extends CanonicalEventName> = Extract<
  CanonicalEvent,
  { name: N }
>["properties"];

/**
 * Display metadata for the analytics UI. Keeps the catalog and its
 * rendering hints in one file so a plugin author adding an event
 * doesn't have to hunt for the UI wiring.
 */
export const EVENT_METADATA: Record<
  CanonicalEventName,
  { label: string; category: "content" | "shop" | "engagement" }
> = {
  page_view: { label: "Page view", category: "content" },
  article_read: { label: "Article read", category: "content" },
  search: { label: "Search", category: "content" },
  cta_click: { label: "CTA click", category: "engagement" },
  product_view: { label: "Product view", category: "shop" },
  add_to_cart: { label: "Add to cart", category: "shop" },
  remove_from_cart: { label: "Remove from cart", category: "shop" },
  begin_checkout: { label: "Begin checkout", category: "shop" },
  add_payment_info: { label: "Add payment info", category: "shop" },
  purchase: { label: "Purchase", category: "shop" },
  refund: { label: "Refund", category: "shop" },
  subscribe: { label: "Newsletter subscribe", category: "engagement" },
  form_submit: { label: "Form submit", category: "engagement" },
  comment_submit: { label: "Comment submit", category: "engagement" },
};

/**
 * Extract `utm_*` params from a URL's search params. Returns undefined
 * when none present so the stored context stays compact.
 */
export function extractUtm(url: URL): EventContext["utm"] {
  const utm: Record<string, string> = {};
  for (const key of [
    "source",
    "medium",
    "campaign",
    "term",
    "content",
  ] as const) {
    const value = url.searchParams.get(`utm_${key}`);
    if (value) utm[key] = value.slice(0, 200);
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

/**
 * Extract the article id from a referrer that points at one of this
 * site's article pages. Returns undefined for cross-site referrers,
 * homepage referrers, or malformed URLs. Enables purchase attribution
 * without a heavier click-tracking system.
 *
 * Match pattern: `/<locale>/articles/<slug>` or `/<locale>/blog/<slug>`.
 * The article id itself is not in the URL (slugs are), so callers
 * pass the referrer to `resolveAttributedArticle()` server-side which
 * queries the content provider to translate slug → id.
 */
export function referrerArticleSlug(
  referrer: string | null | undefined,
  currentOrigin: string,
): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.origin !== currentOrigin) return null;
    // Accept /<locale>/articles/<slug> or /<locale>/blog/<slug>.
    // The locale is any 2-letter code (matches core convention).
    const match = url.pathname.match(
      /^\/[a-z]{2}\/(?:articles|blog)\/([a-z0-9-]+)\/?$/,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
