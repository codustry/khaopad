/// <reference types="@sveltejs/kit" />
/// <reference types="@cloudflare/workers-types" />

declare global {
  namespace App {
    interface Error {
      message: string;
      code?: string;
    }

    interface Locals {
      /** Which subdomain the request is hitting */
      subdomain: "www" | "cms";
      /** Current locale for the request */
      locale: string;
      /** Content provider instance */
      content: import("$lib/server/content/types").ContentProvider;
      /** Media service instance */
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
        CONTENT_MODE: string;
        SUPPORTED_LOCALES: string;
        DEFAULT_LOCALE: string;
        PUBLIC_SITE_URL: string;
        CMS_SITE_URL: string;
        BETTER_AUTH_SECRET: string;
        BETTER_AUTH_URL: string;
        GITHUB_TOKEN?: string;
        GITHUB_OWNER?: string;
        GITHUB_REPO?: string;
        GITHUB_BRANCH?: string;
      };
    }
  }
}

export {};
