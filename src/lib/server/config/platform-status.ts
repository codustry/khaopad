import type { ContentProvider } from "$lib/server/content/types";
import type { MediaService } from "$lib/server/media/types";

export type PlatformValidation =
  | { ok: true }
  | { ok: false; missing: string[]; message: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validates Cloudflare bindings / vars required for D1 + auth + media.
 * When `env` is missing (e.g. `vite dev` without Wrangler), returns a clear message instead of crashing later.
 */
export function validatePlatformEnv(
  env: App.Platform["env"] | undefined | null,
): PlatformValidation {
  if (env == null) {
    return {
      ok: false,
      missing: ["platform.env"],
      message:
        "Cloudflare bindings are not available. Use `wrangler dev` for local development with D1/R2, or deploy with `wrangler deploy`. Plain `vite dev` does not inject `platform.env`.",
    };
  }

  const missing: string[] = [];

  if (!env.DB) missing.push("DB (D1 binding)");
  if (!env.MEDIA_BUCKET) missing.push("MEDIA_BUCKET (R2 binding)");
  if (!isNonEmptyString(env.BETTER_AUTH_SECRET))
    missing.push("BETTER_AUTH_SECRET");
  if (!isNonEmptyString(env.BETTER_AUTH_URL)) missing.push("BETTER_AUTH_URL");
  if (!isNonEmptyString(env.PUBLIC_SITE_URL)) missing.push("PUBLIC_SITE_URL");
  if (!isNonEmptyString(env.CMS_SITE_URL)) missing.push("CMS_SITE_URL");

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message: `Missing or invalid configuration: ${missing.join(", ")}. Check wrangler.toml [vars] and secrets (e.g. BETTER_AUTH_SECRET) in the Cloudflare dashboard.`,
    };
  }

  return { ok: true };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Satisfies `App.Locals` when the platform is not ready (guard returns before any route load uses these). */
export function nullContentPlaceholder(): ContentProvider {
  return null as unknown as ContentProvider;
}

export function nullMediaPlaceholder(): MediaService {
  return null as unknown as MediaService;
}
