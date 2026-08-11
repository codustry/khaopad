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
	const basePath = $derived(localePath(locale, '/products'));
</script>

<!-- SEO is rendered by the layout via page.data.seo. -->

<section class="container mx-auto px-4 py-12">
	<header class="mb-8 flex flex-wrap items-end justify-between gap-4">
		<div>
			<h1 class="text-3xl font-bold">{m.shop_browse_all_products()}</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{m.shop_browse_products_count({ count: String(data.total) })}
			</p>
		</div>
		<SortSelect {basePath} filters={data.filters} sort={data.sort} />
	</header>

	<div class="flex flex-col gap-8 lg:flex-row">
		<FacetSidebar
			{basePath}
			facets={data.facets}
			filters={data.filters}
			sort={data.sort}
			collectionTitles={data.collectionTitles}
		/>

		<div class="min-w-0 flex-1">
			<div class="mb-4 empty:hidden">
				<FilterChips
					{basePath}
					filters={data.filters}
					sort={data.sort}
					collectionTitles={data.collectionTitles}
				/>
			</div>

			{#if data.products.length === 0}
				<div class="rounded-lg border border-border py-16 text-center">
					<p class="text-muted-foreground">
						{hasActiveFilters(data.filters)
							? m.shop_browse_empty_filtered()
							: m.shop_browse_empty()}
					</p>
					{#if hasActiveFilters(data.filters)}
						<a href={basePath} class="mt-3 inline-block text-sm text-primary hover:underline">
							{m.shop_filter_clear_all()}
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
