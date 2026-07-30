<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { track } from '$lib/analytics/track';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const product = $derived(data.product);
	const localization = $derived(data.localization);

	// Bindable variant selector — updates ?variant= without page reload
	// via goto({ replaceState: true, noScroll: true }).
	let selectedId = $state<string>(product.selectedVariantId);
	const selectedVariant = $derived(
		product.variants.find((v) => v.id === selectedId) ?? product.variants[0],
	);

	function onSelectVariant(id: string) {
		selectedId = id;
		const variant = product.variants.find((v) => v.id === id);
		if (!variant?.sku) return;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local throwaway used only to build a query string for goto(); never held as reactive state, so SvelteURLSearchParams buys nothing.
		const params = new URLSearchParams(page.url.searchParams);
		params.set('variant', variant.sku);
		goto(`?${params}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	// Fire product_view once on mount. Tagged with the canonical
	// product id so the per-product dashboard's queries (which key
	// on the same id) actually find these rows.
	//
	// v3.4 federation: if the visitor arrived from an article page
	// (document.referrer matches /[locale]/blog/<slug> OR
	// /[locale]/articles/<slug>), stash the article slug in
	// sessionStorage so the downstream `purchase` event can attribute
	// this order to that article. product_view itself doesn't carry
	// attributedArticleId (dashboard queries filter on `purchase`
	// events); the sessionStorage stash is picked up server-side at
	// checkout-start via a form-posted hidden field (defer to a
	// follow-up sub-PR — this is the client-side half).
	onMount(() => {
		if (!selectedVariant) return;
		track('product_view', {
			productId: product.id,
			variantId: selectedVariant.id,
			priceSatang: selectedVariant.priceSatang,
		});
		try {
			const referrer = document.referrer;
			if (!referrer) return;
			const url = new URL(referrer);
			if (url.origin !== window.location.origin) return;
			const match = url.pathname.match(
				/^\/[a-z]{2}\/(?:articles|blog)\/([a-z0-9-]+)\/?$/,
			);
			if (match?.[1]) {
				sessionStorage.setItem('khaopad_shop_attributed_slug', match[1]);
			}
		} catch {
			// sessionStorage disabled (private mode etc.) — skip
		}
	});
</script>

<!-- SEO is rendered by the layout via page.data.seo. Only the Product
     JSON-LD is injected inline — schema.org rich results validation. -->
<svelte:head>
	<!-- Closing tag split — see the note in collections/[slug]. A literal
	     `</script>` inside a template string terminates this component's
	     script block as far as the parser is concerned. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: server-built JSON-LD, `<` escaped in jsonld.ts -->
	{@html '<script type="application/ld+json">' + data.jsonLd + '<' + '/script>'}
</svelte:head>

<article class="mx-auto max-w-3xl px-6 py-10">
	<header class="mb-6 space-y-2">
		<h1 class="text-3xl font-semibold tracking-tight">
			{localization.title}
		</h1>
		{#if product.vendor}
			<p class="text-sm text-muted-foreground">by {product.vendor}</p>
		{/if}
	</header>

	<section class="mb-8 space-y-4">
		<div class="flex items-baseline gap-3">
			<span class="text-2xl font-semibold tabular-nums">
				{formatSatang(selectedVariant.priceSatang as Satang, data.locale === 'th' ? 'th' : 'en')}
			</span>
			{#if selectedVariant.compareAtSatang && selectedVariant.compareAtSatang > selectedVariant.priceSatang}
				<span class="text-sm text-muted-foreground line-through tabular-nums">
					{formatSatang(selectedVariant.compareAtSatang as Satang, data.locale === 'th' ? 'th' : 'en')}
				</span>
			{/if}
		</div>

		{#if selectedVariant.available > 0}
			<p class="text-sm text-green-700">
				{selectedVariant.available > 10
					? 'In stock'
					: `Only ${selectedVariant.available} left`}
			</p>
		{:else}
			<p class="text-sm text-destructive">Sold out</p>
		{/if}
	</section>

	{#if product.variants.length > 1}
		<section class="mb-8 space-y-2">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Select variant
			</h2>
			<div class="flex flex-wrap gap-2">
				{#each product.variants as variant (variant.id)}
					<button
						type="button"
						onclick={() => onSelectVariant(variant.id)}
						class="rounded-md border px-3 py-2 text-sm transition-colors {selectedId ===
						variant.id
							? 'border-primary bg-primary text-primary-foreground'
							: 'border-input hover:bg-muted'} {variant.available === 0
							? 'opacity-60 line-through'
							: ''}"
						aria-pressed={selectedId === variant.id}
					>
						{variant.titleCached || 'Default'}
					</button>
				{/each}
			</div>
		</section>
	{/if}

	{#if data.descriptionHtml}
		<section class="prose prose-sm max-w-none dark:prose-invert">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- admin-authored markdown rendered server-side by marked; same trust model as blog/pages bodies (authoring is role-gated). Not visitor input. -->
			{@html data.descriptionHtml}
		</section>
	{/if}

	<footer class="mt-10 border-t border-border pt-6">
		<p class="text-sm text-muted-foreground">
			Cart + checkout ship in v3.2 (<a
				href="https://github.com/codustry/khaopad/issues/57"
				class="underline"
				target="_blank"
				rel="noopener">#57</a
			>). Currently browse-only.
		</p>
	</footer>
</article>
