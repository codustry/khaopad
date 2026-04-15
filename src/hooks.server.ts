import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import * as paraglideRuntime from "$lib/paraglide/runtime.js";
import { createAuth } from "$lib/server/auth";
import { createContentProvider } from "$lib/server/content";
import type { ContentMode } from "$lib/server/content";
import { localeFromPathname } from "$lib/i18n";
import { R2MediaService } from "$lib/server/media";

/**
 * Subdomain detection hook.
 * Routes requests to (www) or (cms) route groups based on hostname.
 */
const subdomainHook: Handle = async ({ event, resolve }) => {
  const host = event.request.headers.get("host") ?? "";

  // Determine subdomain
  if (host.startsWith("cms.") || host.includes("cms.")) {
    event.locals.subdomain = "cms";
  } else {
    event.locals.subdomain = "www";
  }

  // Block CMS routes from www and vice versa
  const path = event.url.pathname;
  if (event.locals.subdomain === "www" && isCmsRoute(path)) {
    return new Response("Not Found", { status: 404 });
  }
  if (event.locals.subdomain === "cms" && isWwwOnlyRoute(path)) {
    return new Response("Not Found", { status: 404 });
  }

  return resolve(event);
};

/**
 * Platform bindings hook.
 * Initializes content provider, media service, and locale from Cloudflare bindings.
 */
const bindingsHook: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  const supportedLocales = (env?.SUPPORTED_LOCALES ?? "th,en")
    .split(",")
    .map((s) => s.trim());
  const defaultLocale = env?.DEFAULT_LOCALE ?? "th";
  event.locals.locale = localeFromPathname(
    event.url.pathname,
    supportedLocales,
    defaultLocale,
  );

  if (!env) {
    // Local dev without wrangler — no DB/R2; still match locale + Paraglide to URL path
    return resolve(event, {
      transformPageChunk: ({ html }) =>
        html.replace("%lang%", event.locals.locale),
    });
  }

  // Content provider
  const contentMode = (env.CONTENT_MODE ?? "d1") as ContentMode;
  event.locals.content = createContentProvider(contentMode, env);

  // Media service
  const mediaBaseUrl =
    event.locals.subdomain === "cms"
      ? `${env.CMS_SITE_URL}/api/media`
      : `${env.PUBLIC_SITE_URL}/api/media`;
  event.locals.media = new R2MediaService(
    env.DB,
    env.MEDIA_BUCKET,
    mediaBaseUrl,
  );

  return resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace("%lang%", event.locals.locale),
  });
};

let paraglideAsyncStorageInstalled = false;

function ensureParaglideAsyncStorage(): void {
  if (paraglideAsyncStorageInstalled) return;
  paraglideAsyncStorageInstalled = true;
  if (paraglideRuntime.serverAsyncLocalStorage) return;
  /** @type {{ current?: { locale: string; origin: string; messageCalls: Set<string> } }} */
  const store = {};
  paraglideRuntime.overwriteServerAsyncLocalStorage({
    getStore() {
      return store.current;
    },
    run(s, callback) {
      store.current = s;
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
  const locale =
    /** @type {import("$lib/paraglide/runtime.js").Locale} */ event.locals
      .locale;
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
  if (!env) {
    event.locals.user = null;
    event.locals.session = null;
    return resolve(event);
  }

  const auth = createAuth(env.DB, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
  });

  // Resolve session from request cookies
  const session = await auth.api.getSession({
    headers: event.request.headers,
  });

  if (session) {
    event.locals.user = session.user as App.Locals["user"];
    event.locals.session = session.session as App.Locals["session"];
  } else {
    event.locals.user = null;
    event.locals.session = null;
  }

  return resolve(event);
};

// ─── Route classification helpers ────────────────────────

/** CMS-only route paths (under (cms) group) */
function isCmsRoute(path: string): boolean {
  const cmsRoutes = [
    "/dashboard",
    "/articles",
    "/media",
    "/categories",
    "/users",
    "/settings",
  ];
  return cmsRoutes.some((r) => path.startsWith(r)) || path === "/login";
}

/** Routes that should only be accessible from www */
function isWwwOnlyRoute(path: string): boolean {
  // Blog and locale-prefixed routes are www-only
  return /^\/(th|en)\//.test(path);
}

export const handle = sequence(
  subdomainHook,
  bindingsHook,
  paraglideLocaleHook,
  authHook,
);
