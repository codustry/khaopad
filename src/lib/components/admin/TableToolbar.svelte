<script lang="ts">
	/**
	 * Search, filters and bulk actions above a DataTable.
	 *
	 * ## Why URL state rather than component state
	 *
	 * Search and filter live in the query string, so a filtered view is
	 * linkable, survives reload, and works with the back button. A
	 * `$state` search box loses all three, and "send me the link to the
	 * failed orders" is a real thing people ask each other.
	 *
	 * ## Why the search is debounced but the filters are not
	 *
	 * Typing produces a keystroke per character; a `<select>` produces one
	 * event per decision. Debouncing the select would only add latency to
	 * something already discrete.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui';
	import { Search, X } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import type { Snippet } from 'svelte';

	export type FilterOption = { value: string; label: string };
	export type Filter = {
		/** Query-string parameter this filter writes to. */
		param: string;
		label: string;
		options: FilterOption[];
	};

	let {
		searchParam = 'q',
		searchPlaceholder,
		filters = [],
		selectedCount = 0,
		bulkActions,
		onClearSelection,
		extra
	}: {
		searchParam?: string;
		searchPlaceholder?: string;
		filters?: Filter[];
		/** Non-zero swaps the toolbar for the bulk-action bar. */
		selectedCount?: number;
		bulkActions?: Snippet;
		onClearSelection?: () => void;
		extra?: Snippet;
	} = $props();

	let searchValue = $state(page.url.searchParams.get(searchParam) ?? '');
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	function navigateWith(param: string, value: string) {
		const url = new URL(page.url);
		if (value) url.searchParams.set(param, value);
		else url.searchParams.delete(param);
		// Any filter change invalidates the current page offset — staying
		// on page 4 of a result set that now has two pages shows nothing.
		url.searchParams.delete('page');
		// `keepFocus` so the caret stays in the search box across the
		// navigation; without it every debounce tick steals focus.
		//
		// resolve() takes a route ID, not a URL. This navigates to the
		// CURRENT route with different query params, so there is no route
		// ID to resolve — `url` is derived from `page.url` and is already
		// correct, base path included.
		goto(url, { keepFocus: true, noScroll: true });
	}

	function onSearchInput(event: Event) {
		searchValue = (event.target as HTMLInputElement).value;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => navigateWith(searchParam, searchValue.trim()), 300);
	}

	function clearSearch() {
		searchValue = '';
		clearTimeout(debounceTimer);
		navigateWith(searchParam, '');
	}
</script>

{#if selectedCount > 0}
	<!--
		Replaces the toolbar rather than stacking below it: two competing
		action rows is the layout that makes bulk selection feel unsafe,
		because it is never obvious which set of buttons applies to the
		selection.
	-->
	<div
		role="status"
		aria-live="polite"
		class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-3"
	>
		<p class="text-sm font-medium">
			{m.admin_n_selected({ count: selectedCount })}
		</p>
		<div class="flex flex-wrap items-center gap-2">
			{#if bulkActions}{@render bulkActions()}{/if}
			{#if onClearSelection}
				<Button variant="ghost" size="sm" onclick={onClearSelection}>
					{m.admin_clear_selection()}
				</Button>
			{/if}
		</div>
	</div>
{:else}
	<div class="mb-4 flex flex-wrap items-center gap-3">
		<div class="relative min-w-48 flex-1">
			<Search
				class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<input
				type="search"
				value={searchValue}
				oninput={onSearchInput}
				placeholder={searchPlaceholder ?? m.admin_search()}
				aria-label={searchPlaceholder ?? m.admin_search()}
				class="h-11 w-full rounded-md border border-input bg-background pl-9 pr-9 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
			/>
			{#if searchValue}
				<button
					type="button"
					onclick={clearSearch}
					aria-label={m.admin_clear_search()}
					class="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<X class="h-3.5 w-3.5" aria-hidden="true" />
				</button>
			{/if}
		</div>

		{#each filters as filter (filter.param)}
			<label class="flex items-center gap-2 text-sm">
				<span class="text-muted-foreground">{filter.label}:</span>
				<select
					value={page.url.searchParams.get(filter.param) ?? ''}
					onchange={(e) => navigateWith(filter.param, (e.target as HTMLSelectElement).value)}
					class="h-11 rounded-md border border-input bg-background px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
				>
					<option value="">{m.cms_filter_all()}</option>
					{#each filter.options as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
		{/each}

		{#if extra}{@render extra()}{/if}
	</div>
{/if}
