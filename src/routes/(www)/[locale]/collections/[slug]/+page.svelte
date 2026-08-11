<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale } from '$lib/i18n';
	import { hasActiveFilters } from '$lib/components/shop/browse';
	import ProductCard from '$lib/components/shop/ProductCard.svelte';
	import FacetSidebar from '$lib/components/shop/FacetSidebar.svelte';
	import FilterChips from '$lib/components/shop/FilterChips.svelte';
	import SortSelect from '$lib/components/shop/SortSelect.svelte';
	import BrowsePagination from '$lib/components/shop/BrowsePagination.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = $derived(toLocale(data.locale));
	const basePath = $derived(localePath(locale, `/collections/${data.collection.slug}`));
</script>

<!-- SEO is rendered by the layout via page.data.seo. Only the
     CollectionPage JSON-LD is injected inline. -->

<svelte:head>
	<!-- The closing tag is split so neither the Svelte compiler nor an
	     HTML parser sees a literal `</script>` here — inlined whole, it
	     reads as the end of this component's own script block, which is
	     what ESLint's parser was choking on. Same pattern as
	     $lib/components/seo/Seo.svelte. The payload is already
	     `<`-escaped by buildCollectionJsonLd, so it cannot break out. -->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: server-built JSON-LD, `<` escaped in jsonld.ts -->
	{@html '<script type="application/ld+json">' + data.jsonLd + '<' + '/script>'}
</svelte:head>

<section class="container mx-auto px-4 py-12">
	<header class="mb-8 space-y-2">
		<div class="flex flex-wrap items-end justify-between gap-4">
			<div>
				<h1 class="text-3xl font-bold">{data.collection.title}</h1>
				<p class="mt-1 text-sm text-muted-foreground">
					{m.shop_browse_products_count({ count: String(data.total) })}
				</p>
			</div>
			<SortSelect {basePath} filters={data.filters} sort={data.sort} featuredDefault />
		</div>
		{#if data.descriptionHtml}
			<div class="prose prose-sm max-w-none dark:prose-invert">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- admin-authored markdown rendered server-side by marked; same trust model as blog/pages bodies (authoring is role-gated). Not visitor input. -->
				{@html data.descriptionHtml}
			</div>
		{/if}
	</header>

	<div class="flex flex-col gap-8 lg:flex-row">
		<FacetSidebar {basePath} facets={data.facets} filters={data.filters} sort={data.sort} />

		<div class="min-w-0 flex-1">
			<div class="mb-4 empty:hidden">
				<FilterChips {basePath} filters={data.filters} sort={data.sort} />
			</div>

			{#if data.products.length === 0}
				<div class="rounded-lg border border-border py-16 text-center">
					<p class="text-muted-foreground">
						{hasActiveFilters(data.filters)
							? m.shop_browse_empty_filtered()
							: m.shop_browse_empty_collection()}
					</p>
					{#if hasActiveFilters(data.filters)}
						<a href={basePath} class="mt-3 inline-block text-sm text-primary hover:underline">
							{m.shop_filter_clear_all()}
						</a>
					{:else}
						<a
							href={localePath(locale, '/products')}
							class="mt-3 inline-block text-sm text-primary hover:underline"
						>
							{m.shop_browse_all_products()}
						</a>
					{/if}
				</div>
			{:else}
				<!-- 2-col mobile → 4-col desktop -->
				<div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
					{#each data.products as product (product.id)}
						<ProductCard {product} {locale} />
					{/each}
				</div>
			{/if}

			<BrowsePagination
				{basePath}
				filters={data.filters}
				sort={data.sort}
				page={data.page}
				totalPages={data.totalPages}
			/>
		</div>
	</div>
</section>
