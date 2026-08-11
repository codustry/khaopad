<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import {
		hasActiveFilters,
		serializeBrowseQuery,
		withToggledValue,
		type BrowseFacets,
		type BrowseFilters,
		type BrowseSort,
		type FacetDimension
	} from './browse';

	let {
		basePath,
		facets,
		filters,
		sort,
		collectionTitles = {}
	}: {
		/** localePath'd path of the current browse page. */
		basePath: string;
		facets: BrowseFacets;
		filters: BrowseFilters;
		sort: BrowseSort | null;
		/** slug → localized title, for the collection facet labels. */
		collectionTitles?: Record<string, string>;
	} = $props();

	// Every facet toggle is a plain link (GET, shareable, crawlable) —
	// filter changes drop the page param, so pagination resets.
	function toggleHref(dim: FacetDimension, value: string): string {
		return `${basePath}${serializeBrowseQuery(withToggledValue(filters, dim, value), sort)}`;
	}

	function isSelected(dim: FacetDimension, value: string): boolean {
		switch (dim) {
			case 'collection':
				return filters.collections.includes(value);
			case 'vendor':
				return filters.vendors.includes(value);
			case 'type':
				return filters.productTypes.includes(value);
			default:
				return (filters.options[dim.slice(4)] ?? []).includes(value);
		}
	}

	// The price form must carry every OTHER active param as hidden
	// inputs, or submitting it would silently clear them.
	const priceFormHidden = $derived(
		Array.from(
			new URLSearchParams(
				serializeBrowseQuery(
					{ ...filters, priceMinSatang: null, priceMaxSatang: null },
					sort
				).slice(1)
			).entries()
		)
	);

	const clearAllHref = $derived(
		`${basePath}${serializeBrowseQuery(
			{
				collections: [],
				vendors: [],
				productTypes: [],
				priceMinSatang: null,
				priceMaxSatang: null,
				options: {},
				inStockOnly: false
			},
			sort
		)}`
	);
</script>

{#snippet facetGroup(
	title: string,
	dim: FacetDimension,
	values: Array<{ value: string; count: number }>,
	labelFor: (value: string) => string
)}
	{#if values.length > 0}
		<fieldset class="space-y-1.5">
			<legend class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</legend>
			{#each values as { value, count } (value)}
				{@const selected = isSelected(dim, value)}
				<a
					href={toggleHref(dim, value)}
					class="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted {selected
						? 'font-medium'
						: ''}"
					aria-pressed={selected}
				>
					<span class="flex items-center gap-2">
						<span
							class="flex h-4 w-4 items-center justify-center rounded border {selected
								? 'border-primary bg-primary text-primary-foreground'
								: 'border-input'}"
							aria-hidden="true"
						>
							{#if selected}
								<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
									<path d="m5 13 4 4L19 7" />
								</svg>
							{/if}
						</span>
						{labelFor(value)}
					</span>
					<span class="tabular-nums text-xs text-muted-foreground">{count}</span>
				</a>
			{/each}
		</fieldset>
	{/if}
{/snippet}

{#snippet facetBody()}
	<div class="space-y-6">
		{@render facetGroup(
			m.shop_filter_collection(),
			'collection',
			facets.collections,
			(slug) => collectionTitles[slug] ?? slug
		)}

		<!-- Price range — GET form so the resulting URL is shareable. -->
		<fieldset class="space-y-1.5">
			<legend class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_filter_price()}
			</legend>
			<form method="GET" action={basePath} class="flex items-center gap-2">
				{#each priceFormHidden as [name, value] (name + value)}
					<input type="hidden" {name} {value} />
				{/each}
				<input
					type="number"
					name="price_min"
					min="0"
					step="any"
					value={filters.priceMinSatang != null ? filters.priceMinSatang / 100 : ''}
					placeholder={facets.priceBounds
						? String(Math.floor(facets.priceBounds.minSatang / 100))
						: m.shop_filter_price_min()}
					aria-label={m.shop_filter_price_min()}
					class="w-full min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
				/>
				<span class="text-muted-foreground" aria-hidden="true">–</span>
				<input
					type="number"
					name="price_max"
					min="0"
					step="any"
					value={filters.priceMaxSatang != null ? filters.priceMaxSatang / 100 : ''}
					placeholder={facets.priceBounds
						? String(Math.ceil(facets.priceBounds.maxSatang / 100))
						: m.shop_filter_price_max()}
					aria-label={m.shop_filter_price_max()}
					class="w-full min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
				/>
				<button
					type="submit"
					class="rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted"
				>
					{m.shop_filter_apply()}
				</button>
			</form>
		</fieldset>

		{#each facets.options as group (group.name)}
			{@render facetGroup(group.name, `opt:${group.name}`, group.values, (v) => v)}
		{/each}

		{@render facetGroup(m.shop_filter_vendor(), 'vendor', facets.vendors, (v) => v)}
		{@render facetGroup(m.shop_filter_product_type(), 'type', facets.productTypes, (v) => v)}

		<fieldset>
			<legend class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_filter_availability()}
			</legend>
			<a
				href={toggleHref('stock', '')}
				class="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted {filters.inStockOnly
					? 'font-medium'
					: ''}"
				aria-pressed={filters.inStockOnly}
			>
				<span class="flex items-center gap-2">
					<span
						class="flex h-4 w-4 items-center justify-center rounded border {filters.inStockOnly
							? 'border-primary bg-primary text-primary-foreground'
							: 'border-input'}"
						aria-hidden="true"
					>
						{#if filters.inStockOnly}
							<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
								<path d="m5 13 4 4L19 7" />
							</svg>
						{/if}
					</span>
					{m.shop_filter_in_stock()}
				</span>
				<span class="tabular-nums text-xs text-muted-foreground">{facets.inStockCount}</span>
			</a>
		</fieldset>

		{#if hasActiveFilters(filters)}
			<a href={clearAllHref} class="inline-block text-sm text-primary hover:underline">
				{m.shop_filter_clear_all()}
			</a>
		{/if}
	</div>
{/snippet}

<!-- Desktop: always-visible sidebar. -->
<aside class="hidden w-56 shrink-0 lg:block" aria-label={m.shop_filter_title()}>
	{@render facetBody()}
</aside>

<!-- Mobile: collapsible filter sheet. -->
<details class="rounded-md border border-border lg:hidden" open={hasActiveFilters(filters)}>
	<summary class="cursor-pointer select-none px-4 py-2.5 text-sm font-medium">
		{m.shop_filter_title()}
	</summary>
	<div class="border-t border-border px-4 py-4">
		{@render facetBody()}
	</div>
</details>
