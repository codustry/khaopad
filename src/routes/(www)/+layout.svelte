<script lang="ts">
	import '../../app.css';
	import * as m from '$lib/paraglide/messages';
	import { getAlternateLocale, toLocale } from '$lib/i18n';
	import { resolve } from '$app/paths';
	let { children, data } = $props();
	const locale = $derived.by(() => toLocale(data.locale));
</script>

<div class="min-h-screen flex flex-col">
	<header class="border-b border-border">
		<div class="container mx-auto px-4 py-4 flex items-center justify-between">
			<a href={resolve('/')} class="text-xl font-bold">{m.site_name()}</a>
			<nav class="flex items-center gap-4 text-sm">
				<a href={resolve('/(www)/[locale]/blog', { locale })} class="hover:text-primary">
					{m.nav_blog()}
				</a>
				<a
					href={resolve('/(www)/[locale]', { locale: getAlternateLocale(locale) })}
					data-sveltekit-reload
					class="px-2 py-1 border border-border rounded text-xs hover:bg-muted"
				>
					{m.lang_switch()}
				</a>
			</nav>
		</div>
	</header>

	<main class="flex-1">
		{@render children()}
	</main>

	<footer class="border-t border-border py-8 text-center text-sm text-muted-foreground">
		<p>{m.footer_copyright({ year: new Date().getFullYear().toString() })}</p>
	</footer>
</div>
