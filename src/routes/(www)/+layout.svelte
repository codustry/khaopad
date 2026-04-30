<script lang="ts">
	import '../../app.css';
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale, getAlternateLocale } from '$lib/i18n';
	import { page } from '$app/state';
	import Seo from '$lib/components/seo/Seo.svelte';
	import CookieBanner from '$lib/components/consent/CookieBanner.svelte';
	import type { PageSeo } from '$lib/seo';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

	// Each public +page.server.ts may return `seo: PageSeo`; the layout
	// reads it via $app/state and renders all SEO tags via <Seo />.
	const pageSeo = $derived((page.data.seo as PageSeo | undefined) ?? undefined);
	const seoDefaults = $derived({
		siteName: data.siteSettings?.siteName ?? m.site_name(),
		description: m.site_description(),
		image: undefined,
		twitter: undefined,
	});
</script>

<Seo seo={pageSeo} defaults={seoDefaults} locale={toLocale(data.locale)} />

<div class="min-h-screen flex flex-col">
	<header class="border-b border-border">
		<div class="container mx-auto px-4 py-4 flex items-center justify-between">
			<a href="/" class="text-xl font-bold">{m.site_name()}</a>
			<nav class="flex items-center gap-4 text-sm">
				<a href={localePath(toLocale(data.locale), '/blog')} class="hover:text-primary">
					{m.nav_blog()}
				</a>
				<a
					href={localePath(getAlternateLocale(toLocale(data.locale)), '/')}
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

<CookieBanner
	consent={data.consent}
	privacyHref={localePath(toLocale(data.locale), '/privacy-policy')}
/>
