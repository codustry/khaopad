<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import {
		activeFilterChips,
		serializeBrowseQuery,
		withoutChip,
		type BrowseFilters,
		type BrowseSort
	} from './browse';

	let {
		basePath,
		filters,
		sort,
		collectionTitles = {}
	}: {
		basePath: string;
		filters: BrowseFilters;
		sort: BrowseSort | null;
		collectionTitles?: Record<string, string>;
	} = $props();

	const chips = $derived(activeFilterChips(filters));

	function chipLabel(chip: (typeof chips)[number]): string {
		if (chip.dim === 'stock') return m.shop_filter_in_stock();
		if (chip.dim === 'collection') return collectionTitles[chip.value] ?? chip.value;
		return chip.label;
	}
</script>

{#if chips.length > 0}
	<div class="flex flex-wrap items-center gap-2" aria-label={m.shop_filter_active()}>
		{#each chips as chip (chip.dim + chip.value)}
			{@const label = chipLabel(chip)}
			<a
				href={`${basePath}${serializeBrowseQuery(withoutChip(filters, chip), sort)}`}
				class="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs hover:bg-muted"
				aria-label={m.shop_filter_remove({ label })}
			>
				{label}
				<span aria-hidden="true" class="text-muted-foreground">×</span>
			</a>
		{/each}
	</div>
{/if}
