<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { track } from '$lib/analytics/track';
	import { localePath } from '$lib/i18n';
	import * as m from '$lib/paraglide/messages';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import RecentlyViewed from '$lib/components/shop/RecentlyViewed.svelte';
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

	// ─── Add to cart ────────────────────────────────────────────────
	// POSTs the selected variant to /api/shop/cart, which is same-origin
	// guarded and handles session creation. Previously the page had no
	// way to add anything: cart and checkout existed and worked, but
	// nothing on the product page was wired to them, and a footer note
	// still promised the feature for a release that had long since gone
	// out — so the shop could not take an order at all.
	let adding = $state(false);
	let addError = $state<string | null>(null);
	let added = $state(false);

	async function addToCart() {
		if (!selectedVariant || adding) return;
		adding = true;
		addError = null;
		added = false;
		try {
			const res = await fetch('/api/shop/cart', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ variantId: selectedVariant.id, quantity: 1 })
			});
			if (!res.ok) {
				// Surface the server's reason (out of stock, unknown variant)
				// rather than a generic failure — the customer can act on it.
				const body = await res.json().catch(() => null);
				addError =
					(body && typeof body === 'object' && 'message' in body
						? String(body.message)
						: null) ?? 'Could not add to cart. Please try again.';
				return;
			}
			added = true;
		} catch {
			addError = 'Network error. Please try again.';
		} finally {
			adding = false;
		}
	}
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
		<div class="flex flex-wrap items-center gap-3">
			<button
				type="button"
				onclick={addToCart}
				disabled={adding || !selectedVariant}
				class="h-11 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:h-10"
			>
				{adding ? 'Adding…' : 'Add to cart'}
			</button>
			{#if added}
				<a href={localePath(data.locale, '/cart')} class="text-sm underline">View cart →</a>
			{/if}
		</div>
		{#if addError}
			<p class="mt-3 text-sm text-destructive">{addError}</p>
		{/if}
	</footer>

	<!-- ─── You may also like (#160 A5) ─────────────────────────
	     Server-ranked: order co-occurrence → same collection →
	     catalog affinity. Renders nothing (no header) when empty. -->
	{#if data.related.length > 0}
		<section aria-labelledby="related-products-heading" class="mt-12 border-t border-border pt-8">
			<h2
				id="related-products-heading"
				class="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
			>
				{m.shop_related_title()}
			</h2>
			<ul class="grid grid-cols-2 gap-4 sm:grid-cols-4">
				{#each data.related as item (item.id)}
					<li>
						<!-- TODO: swap to shop/ProductCard once merged -->
						<a
							href={localePath(data.locale, `/products/${item.slug}`)}
							class="block rounded-lg border border-border p-3 transition-colors hover:bg-muted"
						>
							{#if item.mediaId}
								<img
									src={`/api/media/${item.mediaId}`}
									alt=""
									width="160"
									height="160"
									loading="lazy"
									class="mb-2 aspect-square w-full rounded-md border border-border object-cover"
								/>
							{/if}
							<div class="truncate text-sm font-medium">{item.title}</div>
							{#if item.priceFromSatang != null}
								<div class="mt-0.5 text-xs tabular-nums text-muted-foreground">
									{formatSatang(item.priceFromSatang as Satang, data.locale === 'th' ? 'th' : 'en')}
								</div>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- ─── Recently viewed (#160 A6) ───────────────────────────
	     Client-only localStorage strip; records this product on mount
	     but never shows it. Keyed so remounting on product navigation
	     re-runs the capture for the new product. -->
	{#key product.id}
		<RecentlyViewed
			locale={data.locale}
			current={{
				id: product.id,
				slug: product.slug,
				title: localization.title,
				price: selectedVariant?.priceSatang ?? null,
				image: product.featuredMediaId ?? null,
				locale: data.locale,
			}}
		/>
	{/key}
</article>
