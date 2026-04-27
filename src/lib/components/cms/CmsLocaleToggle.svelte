<script lang="ts">
	import { Languages } from 'lucide-svelte';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';

	const current = $derived(getLocale());
	const next = $derived(current === 'en' ? 'th' : 'en');

	function switchLocale() {
		// Cookie strategy: writes the locale cookie and reloads. The Paraglide
		// strategy array `["url", "cookie", "baseLocale"]` falls through to
		// the cookie on /cms/* (no /en or /th prefix to match), so the URL
		// stays clean.
		setLocale(next);
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
