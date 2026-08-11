<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { serializeBrowseQuery, type BrowseFilters, type BrowseSort } from './browse';

	let {
		basePath,
		filters,
		sort,
		page,
		totalPages
	}: {
		basePath: string;
		filters: BrowseFilters;
		sort: BrowseSort | null;
		page: number;
		totalPages: number;
	} = $props();

	function pageHref(p: number): string {
		return `${basePath}${serializeBrowseQuery(filters, sort, p)}`;
	}
</script>

{#if totalPages > 1}
	<nav class="mt-10 flex items-center justify-center gap-4 text-sm" aria-label="Pagination">
		{#if page > 1}
			<a href={pageHref(page - 1)} class="rounded-md border border-border px-3 py-1.5 hover:bg-muted">
				← {m.shop_browse_prev()}
			</a>
		{/if}
		<span class="text-muted-foreground">
			{m.shop_browse_page_of({ page: String(page), total: String(totalPages) })}
		</span>
		{#if page < totalPages}
			<a href={pageHref(page + 1)} class="rounded-md border border-border px-3 py-1.5 hover:bg-muted">
				{m.shop_browse_next()} →
			</a>
		{/if}
	</nav>
{/if}
