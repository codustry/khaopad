import { resolveOrigin } from "$lib/seo";
import type { RequestHandler } from "./$types";

/**
 * GET /robots.txt
 *
 * Per-environment. Production allows all; staging emits Disallow: /
 * to keep the preview off Google. Driven by `WORKERS_ENV` (a wrangler
 * `[vars]` binding); falls back to "production" when unset.
 *
 * Always emits a `Sitemap:` line pointing at the sitemap index, so
 * crawlers find the per-locale sitemaps automatically.
 */
export const GET: RequestHandler = async ({ url, platform, locals }) => {
  const env =
    (platform?.env as { WORKERS_ENV?: string } | undefined)?.WORKERS_ENV ??
    "production";
  const settings = await locals.content.getSettings().catch(() => null);
  const origin = resolveOrigin(url, settings?.cdnBaseUrl);

  const isProd = env === "production";
  const body = isProd
    ? `User-agent: *
Allow: /
Disallow: /cms/
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`
    : `# Non-production environment (${env}) — keep this off search indexes.
User-agent: *
Disallow: /
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
};
