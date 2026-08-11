<script lang="ts">
	import { goto } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { serializeBrowseQuery, type BrowseFilters, type BrowseSort } from './browse';

	let {
		basePath,
		filters,
		sort,
		featuredDefault = false
	}: {
		/** localePath'd path of the current browse page. */
		basePath: string;
		filters: BrowseFilters;
		sort: BrowseSort | null;
		/**
		 * Collection pages: no sort param = the collection's manual
		 * (featured) order, offered as its own option. The products
		 * index has no curated order — null just means newest there.
		 */
		featuredDefault?: boolean;
	} = $props();

	function onChange(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		const next = value === '' ? null : (value as BrowseSort);
		// Sort change resets pagination (serializeBrowseQuery drops page at 1).
		goto(`${basePath}${serializeBrowseQuery(filters, next)}`, { noScroll: true });
	}
</script>

<label class="flex items-center gap-2 text-sm">
	<span class="text-muted-foreground">{m.shop_browse_sort_label()}</span>
	<select
		value={sort ?? (featuredDefault ? '' : 'newest')}
		onchange={onChange}
		class="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
	>
		{#if featuredDefault}
			<option value="">{m.shop_browse_sort_featured()}</option>
		{/if}
		<option value="newest">{m.shop_browse_sort_newest()}</option>
		<option value="price_asc">{m.shop_browse_sort_price_asc()}</option>
		<option value="price_desc">{m.shop_browse_sort_price_desc()}</option>
	</select>
</label>
