<script lang="ts">
	import type { PageSeo } from '$lib/seo';
	import type { Locale } from '$lib/server/content/types';

	type Props = {
		seo: PageSeo | undefined;
		/** Site-wide fallback values from settings. */
		defaults: {
			siteName: string;
			description?: string;
			image?: string;
			twitter?: string;
		};
		/** Current page locale (used as ogLocale fallback when seo.locale is missing). */
		locale: Locale;
	};

	let { seo, defaults, locale }: Props = $props();

	const title = $derived(seo?.title ?? defaults.siteName);
	const description = $derived(seo?.description ?? defaults.description ?? '');
	const canonical = $derived(seo?.canonical);
	const ogType = $derived(seo?.ogType ?? 'website');
	const image = $derived(seo?.image ?? defaults.image);
	const ogLocale = $derived(localeToOg(seo?.locale ?? locale));
	const robots = $derived(seo?.robots);
	const alternates = $derived(seo?.alternates ?? {});
	const jsonLd = $derived(seo?.jsonLd ?? []);

	function localeToOg(l: Locale): string {
		// OG locale codes follow IETF: en_US, th_TH. Khao Pad supports
		// generic "en" and "th"; pick the most common region for each.
		return l === 'th' ? 'th_TH' : 'en_US';
	}
</script>

<svelte:head>
	<title>{title}</title>
	{#if description}
		<meta name="description" content={description} />
	{/if}
	{#if canonical}
		<link rel="canonical" href={canonical} />
	{/if}
	{#if robots}
		<meta name="robots" content={robots} />
	{/if}

	<!-- Open Graph -->
	<meta property="og:title" content={title} />
	{#if description}
		<meta property="og:description" content={description} />
	{/if}
	<meta property="og:type" content={ogType} />
	<meta property="og:locale" content={ogLocale} />
	{#if canonical}
		<meta property="og:url" content={canonical} />
	{/if}
	{#if image}
		<meta property="og:image" content={image} />
	{/if}
	<meta property="og:site_name" content={defaults.siteName} />
	{#if ogType === 'article' && seo?.publishedTime}
		<meta property="article:published_time" content={seo.publishedTime} />
	{/if}
	{#if ogType === 'article' && seo?.modifiedTime}
		<meta property="article:modified_time" content={seo.modifiedTime} />
	{/if}

	<!-- hreflang alternates: tells Google which locale to surface for which region -->
	{#each Object.entries(alternates) as [altLocale, href] (altLocale)}
		<link rel="alternate" hreflang={altLocale} {href} />
	{/each}
	{#if Object.keys(alternates).length > 0 && alternates.en}
		<link rel="alternate" hreflang="x-default" href={alternates.en} />
	{/if}

	<!-- Twitter Card -->
	<meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
	<meta name="twitter:title" content={title} />
	{#if description}
		<meta name="twitter:description" content={description} />
	{/if}
	{#if image}
		<meta name="twitter:image" content={image} />
	{/if}
	{#if defaults.twitter}
		<meta name="twitter:site" content={defaults.twitter} />
	{/if}

	<!-- JSON-LD: one <script> per entry for maximum tooling compatibility -->
	{#each jsonLd as ld, i (i)}
		{@html `<script type="application/ld+json">${JSON.stringify(ld)}<\/script>`}
	{/each}

	<!-- RSS auto-discovery -->
	<link rel="alternate" type="application/rss+xml" title={defaults.siteName} href="/feed.xml" />
</svelte:head>
