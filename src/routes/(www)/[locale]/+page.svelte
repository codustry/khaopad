<script lang="ts">
	/**
	 * Homepage route — a resolver shell since #174 Step 6.
	 *
	 * The markup lives in DefaultHome.svelte; a deployment replaces it with
	 * `setChrome({ home })` from its plugin registrations (client + server —
	 * see chrome.ts for why registration anywhere only the server loads
	 * produces SSR-then-snap-back). This file should never need forking
	 * again: the route, load and SEO are engine-owned, the body is
	 * deployment-owned.
	 */
	import DefaultHome from '$lib/components/www/DefaultHome.svelte';
	import { getChrome } from '$lib/components/www/chrome';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const chrome = $derived(getChrome());
	const HomeComponent = $derived(chrome.home ?? DefaultHome);
</script>

<!-- SEO is handled by the layout's <Seo /> component (see (www)/+layout.svelte). -->
<HomeComponent {data} />
