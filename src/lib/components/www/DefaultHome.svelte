<script lang="ts">
	/**
	 * Default homepage content — Step 6 of the theme/engine split (#174).
	 *
	 * Extracted verbatim from `(www)/[locale]/+page.svelte` so a deployment
	 * can replace the whole page body via `setChrome({ home })` without
	 * forking the route. The route, its load (operator-configurable hero
	 * copy), and SEO stay engine-owned; this file is only the demo's markup.
	 *
	 * The homepage was the project's second-worst merge conflict: 23 lines
	 * upstream against 592 in a real fork, same file, every release. A
	 * deployment's home is a bespoke marketing page — it belongs in a
	 * component the deployment owns, at a path upstream never writes to.
	 */
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale } from '$lib/i18n';
	import type { HomePageProps } from '$lib/components/www/chrome';

	let { data }: HomePageProps = $props();
	const locale = $derived.by(() => toLocale(data.locale));
</script>

<!-- Hero copy is operator-configurable per locale (v3.17 D6, Settings →
     Design); Paraglide strings remain the zero-config default. -->
<section class="container mx-auto px-4 py-16 text-center">
	<h1 class="text-4xl font-bold mb-4">{data.hero?.title ?? m.site_name()}</h1>
	<p class="text-xl text-muted-foreground mb-8">
		{data.hero?.subtitle ?? m.site_description()}
	</p>
	<div class="flex flex-wrap gap-4 justify-center">
		<!-- Shop is the primary CTA on a commerce site; the hero used to
		     offer Blog alone, leaving no path from the home page into the
		     catalog at all. -->
		<a
			href={localePath(locale, '/products')}
			class="inline-flex items-center px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90"
		>
			{m.home_cta_shop()}
		</a>
		<a
			href={localePath(locale, '/blog')}
			class="inline-flex items-center px-6 py-3 border border-border rounded-lg hover:bg-muted"
		>
			{m.nav_blog()}
		</a>
	</div>
</section>
