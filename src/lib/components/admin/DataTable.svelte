<script lang="ts" module>
	/**
	 * The one admin table.
	 *
	 * Wraps the 14 hand-rolled `<table>` blocks across the admin. Getting
	 * these right once is worth more than it looks: the mobile
	 * `overflow-hidden`-instead-of-`overflow-x-auto` bug had to be fixed
	 * in 13 separate files in v3.8.0 precisely because there was no shared
	 * component to fix it in.
	 *
	 * ## Generic over the row type
	 *
	 * `Column<T>` carries the row type through to the `cell` snippet, so a
	 * column that reads `row.titel` is a compile error rather than a blank
	 * cell discovered in the browser.
	 *
	 * ## What is here for Phase 3
	 *
	 * `sortable`/`sortKey`/`sortDir` and the selection props are wired now
	 * but drive no fetching — the parent owns the data. This is
	 * deliberate: designing the surface with search, sort and bulk actions
	 * in mind means Phase 3 extends this component rather than rewriting
	 * every call site a second time.
	 */
	import type { Snippet } from 'svelte';

	export type SortDirection = 'asc' | 'desc';

	export type Column<T> = {
		/** Stable identity, and the value passed to `onSort`. */
		key: string;
		header: string;
		/** Renders the cell. Omit to fall back to `String(row[key])`. */
		cell?: Snippet<[T]>;
		align?: 'left' | 'right' | 'center';
		/** Marks the column sortable. Requires `onSort` to do anything. */
		sortable?: boolean;
		/** Extra classes on both `<th>` and `<td>` — e.g. `hidden sm:table-cell`. */
		class?: string;
		/** Renders numbers with `tabular-nums` so digits align down the column. */
		numeric?: boolean;
	};
</script>

<script lang="ts" generics="T">
	import { cn } from '$lib/utils';
	import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-svelte';

	let {
		columns,
		rows,
		getKey,
		empty,
		caption,
		sortKey,
		sortDir = 'asc',
		onSort,
		selectable = false,
		selected = [],
		onSelectionChange,
		rowHref,
		class: className = ''
	}: {
		columns: Column<T>[];
		rows: T[];
		/** Stable key per row — required, because index keys corrupt on sort. */
		getKey: (row: T) => string;
		/** Shown instead of the table when there are no rows. */
		empty?: Snippet;
		/** Accessible description of the table for screen readers. */
		caption?: string;
		sortKey?: string;
		sortDir?: SortDirection;
		onSort?: (key: string, dir: SortDirection) => void;
		selectable?: boolean;
		selected?: string[];
		onSelectionChange?: (keys: string[]) => void;
		/** Makes rows navigable; renders the first cell as a link. */
		rowHref?: (row: T) => string;
		class?: string;
	} = $props();

	const allKeys = $derived(rows.map(getKey));
	const allSelected = $derived(rows.length > 0 && selected.length === rows.length);
	// Drives the header checkbox's indeterminate state — "some but not all".
	const someSelected = $derived(selected.length > 0 && !allSelected);

	function toggleAll() {
		onSelectionChange?.(allSelected ? [] : allKeys);
	}

	function toggleRow(key: string) {
		onSelectionChange?.(
			selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]
		);
	}

	function headerSort(col: Column<T>) {
		if (!col.sortable || !onSort) return;
		// Re-clicking the active column flips direction; a new column
		// starts ascending, which is what every table in this class does.
		const nextDir: SortDirection = sortKey === col.key && sortDir === 'asc' ? 'desc' : 'asc';
		onSort(col.key, nextDir);
	}

	const alignClass = (col: Column<T>) =>
		col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';
</script>

{#if rows.length === 0 && empty}
	<div class="rounded-lg border border-dashed border-border p-8 text-center">
		{@render empty()}
	</div>
{:else}
	<!--
		`overflow-x-auto` and NOT `overflow-hidden`: the latter clips wide
		tables on a phone instead of letting them scroll, which is the
		exact defect fixed across 13 files in v3.8.0.
	-->
	<div class={cn('overflow-x-auto rounded-lg border border-border', className)}>
		<table class="w-full text-sm">
			{#if caption}
				<caption class="sr-only">{caption}</caption>
			{/if}
			<thead class="bg-muted">
				<tr>
					{#if selectable}
						<th scope="col" class="w-10 px-4 py-3">
							<input
								type="checkbox"
								checked={allSelected}
								indeterminate={someSelected}
								onchange={toggleAll}
								aria-label="Select all rows"
								class="h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
							/>
						</th>
					{/if}
					{#each columns as col (col.key)}
						{@const isActive = sortKey === col.key}
						<th
							scope="col"
							class={cn('px-4 py-3 font-medium', alignClass(col), col.class)}
							aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
						>
							{#if col.sortable && onSort}
								<button
									type="button"
									onclick={() => headerSort(col)}
									class={cn(
										'-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
										col.align === 'right' && 'flex-row-reverse',
										!isActive && 'text-muted-foreground'
									)}
								>
									{col.header}
									{#if isActive}
										{#if sortDir === 'asc'}
											<ArrowUp class="h-3.5 w-3.5" aria-hidden="true" />
										{:else}
											<ArrowDown class="h-3.5 w-3.5" aria-hidden="true" />
										{/if}
									{:else}
										<ArrowUpDown class="h-3.5 w-3.5 opacity-40" aria-hidden="true" />
									{/if}
								</button>
							{:else}
								{col.header}
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row (getKey(row))}
					{@const key = getKey(row)}
					<tr class="border-t border-border transition-colors hover:bg-muted/50">
						{#if selectable}
							<td class="px-4 py-3">
								<input
									type="checkbox"
									checked={selected.includes(key)}
									onchange={() => toggleRow(key)}
									aria-label="Select row"
									class="h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
								/>
							</td>
						{/if}
						{#each columns as col, i (col.key)}
							<td
								class={cn(
									'px-4 py-3',
									alignClass(col),
									col.numeric && 'tabular-nums',
									col.class
								)}
							>
								{#if i === 0 && rowHref}
									<!--
										Only the first cell links. A whole-row <a> would swallow
										the action buttons that live in the last column.
									-->
									<a
										href={rowHref(row)}
										class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
									>
										{#if col.cell}{@render col.cell(row)}{:else}{String(
												(row as Record<string, unknown>)[col.key] ?? ''
											)}{/if}
									</a>
								{:else if col.cell}
									{@render col.cell(row)}
								{:else}
									{String((row as Record<string, unknown>)[col.key] ?? '')}
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
