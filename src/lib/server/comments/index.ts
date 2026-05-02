/**
 * v2.0c comment-policy helper.
 *
 * The dual-toggle: site-wide `settings.commentsEnabled` (defaults to
 * `false` so a fresh deploy never accidentally exposes a comment form)
 * AND per-article `commentsMode` (`inherit` | `on` | `off`).
 *
 * `on`  — force comments on for this article regardless of site setting.
 * `off` — force comments off for this article regardless of site setting.
 * `inherit` — defer to the site setting.
 */
import type { ArticleRecord, SiteSettings } from "$lib/server/content/types";

export function commentsAllowedForArticle(
  article: Pick<ArticleRecord, "commentsMode">,
  settings: SiteSettings | null,
): boolean {
  if (article.commentsMode === "on") return true;
  if (article.commentsMode === "off") return false;
  // inherit
  return settings?.commentsEnabled === true;
}

// `maskEmail` lives in $lib/comments/mask so the CMS Svelte page can
// import it client-side. Re-export so server-side callers don't need
// to know which directory it sits in.
export { maskEmail } from "$lib/comments/mask";
