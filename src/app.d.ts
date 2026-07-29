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
       * "admin" for `/admin/*`, "www" for everything else (public).
       */
      surface: "www" | "admin";
      /** @deprecated Use `surface`. Kept as alias during the v1.1 migration. */
      subdomain: "www" | "admin";
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
        // ─── @khaopad/plugin-shop (optional) ───────────────
        // Present when the shop plugin's payment adapter is configured.
        // Absent when the shop is running in browse-only mode (no checkout).
        BEAM_API_KEY?: string;
        BEAM_WEBHOOK_SECRET?: string;
        BEAM_BASE_URL?: string;
        /**
         * Shared secret for /api/shop/cron/sweep. Set in wrangler.toml
         * [vars] as a random 64-char string; used by Cloudflare Cron
         * Triggers as `?token=<CRON_SECRET>`. Absent = cron endpoint 401s.
         */
        CRON_SECRET?: string;
        /**
         * Resend API key + verified sender for order receipt emails.
         * Absent = checkout still succeeds, customer just doesn't
         * receive a receipt (they can lookup via /order/[number]).
         * Same provider as v2.0b newsletter.
         */
        RESEND_API_KEY?: string;
        RESEND_FROM?: string;
      };
    }
  }
}

export {};
