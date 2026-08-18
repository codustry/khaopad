import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import * as paraglideRuntime from "$lib/paraglide/runtime.js";
import { createAuth } from "$lib/server/auth";
import {
  escapeHtml,
  nullContentPlaceholder,
  nullMediaPlaceholder,
  validatePlatformEnv,
} from "$lib/server/config/platform-status";
import { createContentProvider } from "$lib/server/content";
import { QueryCache } from "$lib/server/content/query/cache";
import { localeFromPathname } from "$lib/i18n";
import { R2MediaService } from "$lib/server/media";
import { initPlugins } from "$lib/plugins";
import { injectAppHead } from "$lib/server/app-head";

/**
 * Surface detection hook.
 *
 * Khao Pad is one SvelteKit app serving two surfaces from the same host:
 * the public site at `/*` and the admin CMS at `/admin/*`. We tag every
 * request with `event.locals.surface` so downstream hooks (auth, media,
 * locale) can branch on it without re-parsing the URL.
 *
 * The previous design used host-based routing (`cms.example.com` vs
 * `www.example.com`). That broke on cookieless, single-host deploys
 * (workers.dev, localhost) and contradicted Paraglide's recommendation
 * that private routes live under a path prefix and read locale from
 * cookies. See docs/ARCHITECTURE.md for the migration rationale.
 */
const surfaceHook: Handle = async ({ event, resolve }) => {
  event.locals.surface = isAdminPath(event.url.pathname) ? "admin" : "www";
  // Back-compat: `subdomain` is still read by older hooks. Keep until removed.
  event.locals.subdomain = event.locals.surface;
  return resolve(event);
};

/**
 * Platform bindings hook.
 * Initializes content provider, media service, and locale from Cloudflare bindings.
 */
const bindingsHook: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  const supportedLocales = (env?.SUPPORTED_LOCALES ?? "en,th")
    .split(",")
    .map((s) => s.trim());
  const defaultLocale = env?.DEFAULT_LOCALE ?? "en";
  // Locale resolution differs by surface, deliberately.
  //
  //   (www)   → URL segment. /en/blog vs /th/blog is SEO-visible and
  //             shareable, so the path is the source of truth.
  //   (admin) → COOKIE. The CMS is intentionally locale-prefix-free: it
  //             is a private surface with no SEO need, and prefixing
  //             would turn /admin/articles into /th/admin/articles.
  //
  // The admin case was previously missing. `localeFromPathname` sees
  // "admin" as the first segment, finds it isn't a supported locale, and
  // falls back to DEFAULT_LOCALE — so the CMS was pinned to English no
  // matter what. AdminLocaleToggle wrote PARAGLIDE_LOCALE and reloaded,
  // but nothing ever read that cookie, so the toggle did nothing.
  if (event.locals.surface === "admin") {
    const cookieLocale = event.cookies.get(paraglideRuntime.cookieName);
    event.locals.locale =
      cookieLocale && supportedLocales.includes(cookieLocale)
        ? cookieLocale
        : defaultLocale;
  } else {
    event.locals.locale = localeFromPathname(
      event.url.pathname,
      supportedLocales,
      defaultLocale,
    );
  }

  const validation = validatePlatformEnv(env);

  if (!validation.ok) {
    event.locals.platformReady = false;
    event.locals.configurationError = validation.message;
    event.locals.configurationMissing = validation.missing;
    event.locals.content = nullContentPlaceholder();
    event.locals.media = nullMediaPlaceholder();
    return resolve(event, {
      transformPageChunk: ({ html }) =>
        injectAppHead(html.replace("%lang%", event.locals.locale)),
    });
  }

  try {
    // `platform.context` carries the Worker execution context; passing
    // it lets cache invalidation outlive the response (Phase 1, #68).
    event.locals.content = createContentProvider(env!, event.platform?.context);

    const mediaBaseUrl =
      event.locals.subdomain === "admin"
        ? `${env!.CMS_SITE_URL}/api/media`
        : `${env!.PUBLIC_SITE_URL}/api/media`;
    event.locals.media = new R2MediaService(
      env!.DB,
      env!.MEDIA_BUCKET,
      mediaBaseUrl,
      // Media is a populate target (articles.coverMedia), so a media
      // write has to drop cached article payloads that embedded it.
      () => {
        if (!env!.CONTENT_CACHE) return;
        const pending = new QueryCache(env!.CONTENT_CACHE).invalidateMany([
          "media",
          "articles",
        ]);
        if (event.platform?.context?.waitUntil) {
          event.platform.context.waitUntil(pending);
        } else {
          void pending;
        }
      },
    );
    event.locals.platformReady = true;
    event.locals.configurationError = null;
    event.locals.configurationMissing = [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    event.locals.platformReady = false;
    event.locals.configurationError = `Failed to initialize services: ${msg}`;
    event.locals.configurationMissing = ["initialization"];
    event.locals.content = nullContentPlaceholder();
    event.locals.media = nullMediaPlaceholder();
  }

  return resolve(event, {
    transformPageChunk: ({ html }) =>
      injectAppHead(html.replace("%lang%", event.locals.locale)),
  });
};

function isConfigurationCheckExempt(pathname: string): boolean {
  if (pathname.startsWith("/@")) return true;
  if (pathname.startsWith("/node_modules/")) return true;
  if (pathname.startsWith("/.svelte-kit/")) return true;
  if (pathname.startsWith("/src/")) return true;
  if (pathname.startsWith("/_app/")) return true;
  if (pathname === "/favicon.png") return true;
  return false;
}

function configurationErrorPayload(locals: App.Locals) {
  return {
    error: "configuration_required",
    message: locals.configurationError ?? "Application is not configured.",
    missing: locals.configurationMissing,
  };
}

function configurationErrorHtml(locals: App.Locals): string {
  const body = escapeHtml(
    locals.configurationError ?? "Application is not configured.",
  );
  const missing = locals.configurationMissing
    .map((m) => escapeHtml(m))
    .join(", ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Configuration required</title>
<style>
body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1.5rem;line-height:1.5;color:#1a1a1a;background:#fafafa}
h1{font-size:1.25rem;margin:0 0 1rem}
p{margin:0 0 1rem}
code,pre{font-size:0.85rem;background:#eee;padding:0.2em 0.4em;border-radius:4px}
pre{white-space:pre-wrap;padding:1rem}
</style>
</head>
<body>
<h1>Configuration required</h1>
<p>${body}</p>
<p><strong>Missing or invalid:</strong> ${missing || "(none listed)"}</p>
</body>
</html>`;
}

const configurationGuardHook: Handle = async ({ event, resolve }) => {
  if (
    event.locals.platformReady ||
    isConfigurationCheckExempt(event.url.pathname)
  ) {
    return resolve(event);
  }

  const wantsJson =
    event.request.headers.get("accept")?.includes("application/json") ||
    event.url.pathname.startsWith("/api/");

  if (wantsJson) {
    return new Response(
      JSON.stringify(configurationErrorPayload(event.locals)),
      {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  return new Response(configurationErrorHtml(event.locals), {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

let paraglideAsyncStorageInstalled = false;

function ensureParaglideAsyncStorage(): void {
  if (paraglideAsyncStorageInstalled) return;
  paraglideAsyncStorageInstalled = true;
  if (paraglideRuntime.serverAsyncLocalStorage) return;
  type ParaglideServerStore = {
    locale: import("$lib/paraglide/runtime.js").Locale;
    origin: string;
    messageCalls: Set<string>;
  };
  const store: { current?: ParaglideServerStore } = {};
  paraglideRuntime.overwriteServerAsyncLocalStorage({
    getStore() {
      return store.current;
    },
    run(s, callback) {
      store.current = s as ParaglideServerStore;
      return Promise.resolve(callback()).finally(() => {
        store.current = undefined;
      });
    },
  });
}

/**
 * Paraglide SSR: `getLocale()` reads AsyncLocalStorage from middleware; without it, cookie
 * can win and English stays stuck after switching. We set locale from `event.locals.locale`
 * (same as URL) and keep SvelteKit’s URL unchanged (no de-localization).
 */
const paraglideLocaleHook: Handle = async ({ event, resolve }) => {
  ensureParaglideAsyncStorage();
  const locale = event.locals
    .locale as import("$lib/paraglide/runtime.js").Locale;
  return paraglideRuntime.serverAsyncLocalStorage!.run(
    {
      locale,
      origin: event.url.origin,
      messageCalls: new Set(),
    },
    () => resolve(event),
  );
};

/**
 * Auth hook.
 * Resolves the current user session from Better Auth cookies.
 */
const authHook: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  if (!env || !event.locals.platformReady) {
    event.locals.user = null;
    event.locals.session = null;
    return resolve(event);
  }

  const auth = createAuth(env.DB, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    RESEND_API_KEY: env.RESEND_API_KEY,
    RESEND_FROM: env.RESEND_FROM,
    CONTENT_CACHE: env.CONTENT_CACHE,
  });

  // Resolve session from request cookies. Wrap defensively: getSession
  // can throw if the cookie is malformed or if a session-refresh write
  // fails, and we don't want every page to 500 over auth lookup.
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({
      headers: event.request.headers,
    });
  } catch {
    session = null;
  }

  if (session) {
    event.locals.user = session.user as unknown as App.Locals["user"];
    event.locals.session = session.session as unknown as App.Locals["session"];
  } else {
    event.locals.user = null;
    event.locals.session = null;
  }

  return resolve(event);
};

// ─── Route classification helpers ────────────────────────

/**
 * Returns true if the request targets the admin surface (`/admin/*`).
 * Single source of truth — used by every hook that needs to branch on surface.
 */
function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

/**
 * Personal-state storefront paths (#146): pages whose rendered HTML is
 * derived from the visitor's cart cookie or an order lookup. Caching
 * these `public` served one visitor's cart — and on /order/[n], their
 * order details — to every other visitor on the same PoP for up to five
 * minutes, and made every cart mutation look broken (the post-mutation
 * reload re-served the pre-mutation copy while D1 was correct all
 * along).
 *
 * Matches both the localized paths (/{locale}/cart, the real pages
 * after #141) and the unprefixed ones (redirect stubs — a 303 keyed on
 * a cookie is exactly as personal as the page it forwards to).
 */
function isShopFunnelPath(path: string): boolean {
  // `account` (v3.17 D1) is per-visitor by definition: order history +
  // saved addresses. Public-caching it would serve one customer's
  // orders to the next visitor on the same PoP — same failure mode as
  // the original cart bug.
  return /^(?:\/[a-z]{2})?\/(cart|checkout|lookup|order|account)(\/|$)/.test(
    path,
  );
}

/**
 * v1.9 cache-control hook.
 *
 * Sets sensible defaults at the edge so Cloudflare's cache fronts the
 * worker for stable public reads, and never caches authenticated CMS
 * surfaces. Only sets the header when the response doesn't already
 * have one (so per-route overrides — e.g. /sitemap.xml, /robots.txt,
 * /api/health — keep their explicit values).
 *
 * - /admin/*           → no-store (authenticated, must always be fresh)
 * - shop funnel      → no-store (per-visitor cart/order state, #146)
 * - /api/auth/*      → no-store (auth state)
 * - /api/media/*     → public, max-age=86400, stale-while-revalidate=604800
 *                      (R2 blobs are immutable per id+key, very cacheable)
 * - /api/*           → no-store (default API endpoints)
 * - /blog/[slug]     → public, max-age=120, s-maxage=600, swr=86400
 *                      (read-heavy, edits rare; SWR keeps things snappy)
 * - everything else  → public, max-age=60, s-maxage=300, swr=86400
 *
 * Edge caches honor `s-maxage`; browsers honor `max-age`. SWR lets us
 * serve a slightly stale version while a single revalidation hits the
 * worker — visitor sees a fast response, content stays fresh on the
 * order of minutes.
 */
const cacheHook: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  if (response.headers.has("cache-control")) return response;

  const path = event.url.pathname;
  let value: string;
  if (path === "/admin" || path.startsWith("/admin/")) {
    value = "no-store";
  } else if (isShopFunnelPath(path)) {
    // Cart/checkout/order HTML is per-visitor state (#146). `private`
    // would only stop shared caches; `no-store` also stops the browser
    // from replaying a pre-mutation cart on back/forward.
    value = "no-store";
  } else if (path.startsWith("/api/auth/") || path === "/api/consent") {
    value = "no-store";
  } else if (path.startsWith("/api/media/")) {
    value = "public, max-age=86400, stale-while-revalidate=604800";
  } else if (path.startsWith("/api/")) {
    value = "no-store";
  } else if (path.match(/\/blog\/[^/]+$/)) {
    value = "public, max-age=120, s-maxage=600, stale-while-revalidate=86400";
  } else {
    value = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
  }
  response.headers.set("cache-control", value);
  return response;
};

/**
 * Security headers hook.
 *
 * The real threat model on a same-host admin (`/admin` on the same origin
 * as public content) is stored-XSS in user-generated content exfiltrating
 * the admin session cookie. HttpOnly on the cookie blocks the primary
 * `document.cookie` vector; CSP closes off script injection at the source.
 *
 * The CSP itself is defined in svelte.config.js (`kit.csp`), NOT here.
 * SvelteKit must own it so it can nonce its own inline hydration
 * bootstrap. This file previously set `script-src 'self'` by hand on the
 * reasoning that "public HTML never legitimately needs inline JS" — but
 * SvelteKit's bootstrap IS inline JS on every page, so the browser
 * refused it and the entire app shipped as inert HTML.
 *
 * `csp.mode: "auto"` keeps the policy strict (nonce per response, hashes
 * where prerendered) rather than resorting to 'unsafe-inline', which
 * would reopen the stored-XSS hole this policy exists to close.
 *
 * Same-origin defenses beyond CSP:
 * - `X-Content-Type-Options: nosniff` — kills MIME sniffing attacks
 * - `Referrer-Policy: strict-origin-when-cross-origin` — narrows leakage
 * - `Permissions-Policy` — denies sensor/camera/mic access we never use
 * - HSTS is set by Cloudflare in front of the Worker; not our job
 */
const SECURITY_HEADERS_STATIC: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Frame-Options": "DENY",
};

const securityHeadersHook: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  for (const [name, value] of Object.entries(SECURITY_HEADERS_STATIC)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }

  // Keep non-production workers out of search indexes (#145).
  //
  // robots.txt alone is not enough for two reasons the reporter hit in
  // sequence on a real staging worker:
  //  1. It only limits *crawling*; a Disallowed URL can still be indexed
  //     from external links.
  //  2. Cloudflare's managed "Content Signals" prepends its own
  //     `User-agent: * / Allow: /` block to robots.txt, and Google's
  //     tie-break between equal-length Allow and Disallow prefers Allow —
  //     silently neutralizing the origin's `Disallow: /`.
  // The header forbids indexing at the response level, which nothing in
  // front of the Worker rewrites. Deliberately fail-closed: an unset
  // WORKERS_ENV is treated as non-production, because a var the operator
  // must remember in order to be safe isn't a safeguard.
  const workersEnv =
    (event.platform?.env as { WORKERS_ENV?: string } | undefined)
      ?.WORKERS_ENV ?? "";
  if (workersEnv !== "production") {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  // NOTE: the CSP is deliberately NOT set here. SvelteKit generates it
  // (svelte.config.js `kit.csp`) so it can attach a nonce to its own
  // inline hydration bootstrap. A hand-written policy here would clobber
  // that nonce — which is exactly what the previous `script-src 'self'`
  // did: the browser refused the bootstrap, hydration never ran, and the
  // whole app was served as inert HTML with non-functioning forms.

  return response;
};

/**
 * Plugin init hook.
 *
 * Calls each plugin's optional `onInit(ctx)` hook once per Worker
 * cold start. Most plugins don't need this — sidebar nav / webhook
 * event registration happens at module load (see
 * `$lib/plugins/registrations`). `onInit` is reserved for plugins
 * that need `env` at first-request time (e.g. warming a KV cache,
 * conditional seeding).
 *
 * Idempotent: safe to call from every request; only runs once per
 * isolate. Skipped when platform is not ready.
 */
const pluginInitHook: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  if (env && event.locals.platformReady) {
    await initPlugins({ env });
  }
  return resolve(event);
};

/**
 * Analytics page_view hook — fires ONCE per public HTML page load.
 *
 * Skip conditions (in order of frequency):
 *   - Non-GET (POST/PATCH/DELETE/etc. — not a page view)
 *   - Admin surface (/admin/* — internal traffic, not audience metric)
 *   - API routes (/api/* — data endpoints, not pages)
 *   - Static asset paths (favicon, sitemap.xml, robots.txt, RSS)
 *   - Response with Accept header pointing at JSON (SvelteKit client
 *     navigation prefetch fetches JSON, not HTML)
 *
 * Fired AFTER resolve() so the response status is known — a 4xx/5xx
 * doesn't count as a page view. Fire-and-forget: never blocks the
 * response.
 */
const analyticsPageViewHook: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  // Late-bind the import so a broken analytics module never breaks
  // the whole hook chain.
  try {
    if (event.request.method !== "GET") return response;
    if (event.locals.surface === "admin") return response;
    if (!event.locals.platformReady) return response;
    const path = event.url.pathname;
    if (
      path.startsWith("/api/") ||
      path.startsWith("/_app/") ||
      path === "/favicon.png" ||
      path === "/favicon.ico" ||
      path === "/robots.txt" ||
      path.startsWith("/sitemap") ||
      path.startsWith("/feed")
    ) {
      return response;
    }
    // SPA client-navigation data fetches — SvelteKit hits
    // `/<path>/__data.json?...` on every soft nav; if we don't skip
    // these, every navigation fires TWO page_views (initial SSR + the
    // subsequent data-only fetch). The `Accept: application/json`
    // check from the initial commit isn't reliable — SvelteKit sends
    // default Accept. Filter on the URL shape + on SvelteKit's
    // `isDataRequest` flag (set by the runtime for internal fetches).
    if (
      path.endsWith("/__data.json") ||
      event.url.searchParams.has("x-sveltekit-invalidated") ||
      // isDataRequest exists on SvelteKit >=2 for exactly this case
      (event as unknown as { isDataRequest?: boolean }).isDataRequest === true
    ) {
      return response;
    }
    // Count only successful renders (2xx). 3xx redirects don't count
    // as viewed pages — an auth redirect at `/admin` → `/admin/login`
    // shouldn't inflate homepage view counts. 4xx/5xx errors also
    // aren't real content-served pages.
    if (response.status >= 300) return response;
    const env = event.platform?.env;
    if (!env) return response;
    const { track, buildEventContext } =
      await import("$lib/server/analytics/track");
    const { ensureCartSession } = await import("$plugins/shop/cart-cookie");
    const sessionId = ensureCartSession(event.cookies);
    const localeMatch = /^\/([a-z]{2})\//.exec(path);
    void track(
      env.DB,
      "page_view",
      { title: undefined },
      buildEventContext({
        url: event.url,
        request: event.request,
        sessionId,
        userId: event.locals.user?.id ?? null,
        locale: localeMatch?.[1] ?? event.locals.locale ?? "en",
      }),
    );
  } catch {
    /* analytics failure never blocks a request */
  }
  return response;
};

export const handle = sequence(
  surfaceHook,
  bindingsHook,
  configurationGuardHook,
  pluginInitHook,
  paraglideLocaleHook,
  authHook,
  cacheHook,
  securityHeadersHook,
  analyticsPageViewHook,
);
