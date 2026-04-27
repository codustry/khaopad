/// <reference types="@sveltejs/kit" />
/// <reference types="@cloudflare/workers-types" />

declare global {
  namespace App {
    interface Error {
      message: string;
      code?: string;
    }

    interface Locals {
      /**
       * Which surface the request is hitting.
       * "cms" for `/cms/*` (admin), "www" for everything else (public).
       */
      surface: "www" | "cms";
      /** @deprecated Use `surface`. Kept as alias during the v1.1 migration. */
      subdomain: "www" | "cms";
      /** Current locale for the request */
      locale: string;
      /** True when D1/R2 and required secrets are present and services were constructed */
      platformReady: boolean;
      /** Human-readable reason when `platformReady` is false */
      configurationError: string | null;
      /** Missing binding / var names when `platformReady` is false */
      configurationMissing: string[];
      /** Content provider instance (only when `platformReady`) */
      content: import("$lib/server/content/types").ContentProvider;
      /** Media service instance (only when `platformReady`) */
      media: import("$lib/server/media/types").MediaService;
      /** Authenticated user (null if not logged in) */
      user: import("$lib/server/auth/types").AuthUser | null;
      /** Auth session (null if not logged in) */
      session: import("$lib/server/auth/types").AuthSession | null;
    }

    interface Platform {
      env: {
        DB: D1Database;
        MEDIA_BUCKET: R2Bucket;
        CONTENT_CACHE: KVNamespace;
        SUPPORTED_LOCALES: string;
        DEFAULT_LOCALE: string;
        PUBLIC_SITE_URL: string;
        CMS_SITE_URL: string;
        BETTER_AUTH_SECRET: string;
        BETTER_AUTH_URL: string;
      };
    }
  }
}

export {};
