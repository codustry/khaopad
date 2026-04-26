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
import type { ContentMode } from "$lib/server/content";
import { localeFromPathname } from "$lib/i18n";
import { R2MediaService } from "$lib/server/media";

/**
 * Surface detection hook.
 *
 * Khao Pad is one SvelteKit app serving two surfaces from the same host:
 * the public site at `/*` and the admin CMS at `/cms/*`. We tag every
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
  event.locals.surface = isCmsPath(event.url.pathname) ? "cms" : "www";
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
  event.locals.locale = localeFromPathname(
    event.url.pathname,
    supportedLocales,
    defaultLocale,
  );

  const validation = validatePlatformEnv(env);

  if (!validation.ok) {
    event.locals.platformReady = false;
    event.locals.configurationError = validation.message;
    event.locals.configurationMissing = validation.missing;
    event.locals.content = nullContentPlaceholder();
    event.locals.media = nullMediaPlaceholder();
    return resolve(event, {
      transformPageChunk: ({ html }) =>
        html.replace("%lang%", event.locals.locale),
    });
  }

  try {
    const contentMode = (env!.CONTENT_MODE ?? "d1") as ContentMode;
    event.locals.content = createContentProvider(contentMode, env!);

    const mediaBaseUrl =
      event.locals.subdomain === "cms"
        ? `${env!.CMS_SITE_URL}/api/media`
        : `${env!.PUBLIC_SITE_URL}/api/media`;
    event.locals.media = new R2MediaService(
      env!.DB,
      env!.MEDIA_BUCKET,
      mediaBaseUrl,
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
      html.replace("%lang%", event.locals.locale),
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
  });

  // Resolve session from request cookies
  const session = await auth.api.getSession({
    headers: event.request.headers,
  });

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
 * Returns true if the request targets the admin CMS surface.
 * Single source of truth — used by every hook that needs to branch on surface.
 */
function isCmsPath(path: string): boolean {
  return path === "/cms" || path.startsWith("/cms/");
}

export const handle = sequence(
  surfaceHook,
  bindingsHook,
  configurationGuardHook,
  paraglideLocaleHook,
  authHook,
);
