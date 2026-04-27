<script lang="ts">
	import { Languages } from 'lucide-svelte';
	import { getLocale, cookieName, cookieMaxAge } from '$lib/paraglide/runtime';

	const current = $derived(getLocale());
	const next = $derived(current === 'en' ? 'th' : 'en');

	/**
	 * Switch the CMS UI locale **without changing the URL**.
	 *
	 * Why we don't call Paraglide's built-in `setLocale()`:
	 *   `setLocale()` walks every strategy in the configured array
	 *   `["url", "cookie", "baseLocale"]`. The URL strategy fires first
	 *   and rewrites `window.location.href` via `localizeUrl()` — for a
	 *   path like `/cms/articles` that turns into `/th/cms/articles`,
	 *   which is wrong: the CMS surface is intentionally locale-prefix-
	 *   free (private route, cookie-only locale, no SEO need). There is
	 *   no per-strategy opt-out on `setLocale()` itself, so we write the
	 *   cookie by hand and soft-reload via SvelteKit's invalidation.
	 *
	 * The `(www)` public site keeps the URL strategy untouched so
	 * `/en/blog` ↔ `/th/blog` continues to work correctly there.
	 */
	function switchLocale() {
		if (typeof document === 'undefined') return;
		document.cookie = `${cookieName}=${next}; path=/; max-age=${cookieMaxAge}; SameSite=Lax`;
		// Full reload picks up the new locale via SSR. We can't use
		// invalidateAll() here: Paraglide messages are bound at the module
		// scope and a soft data refresh doesn't re-evaluate them.
		window.location.reload();
	}
</script>

<button
	type="button"
	onclick={switchLocale}
	class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-accent-foreground"
	aria-label={`Switch to ${next === 'th' ? 'Thai' : 'English'}`}
	title={`Switch to ${next === 'th' ? 'Thai' : 'English'}`}
>
	<Languages class="h-3.5 w-3.5" aria-hidden="true" />
	{next.toUpperCase()}
</button>
