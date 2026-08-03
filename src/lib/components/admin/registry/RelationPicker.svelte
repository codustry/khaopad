<script lang="ts">
	/**
	 * Searchable relation picker (#126) — replaces the bare <select>.
	 *
	 * A combobox built in-repo, following CommandPalette.svelte's a11y
	 * pattern (role="combobox" + aria-activedescendant over a listbox)
	 * rather than pulling a dependency. Selection is posted as ONE hidden
	 * comma-joined input, always present even when empty — that is what
	 * makes clearing a single-valued relation persist: an absent key means
	 * "don't touch the edges", an empty value means "delete them".
	 *
	 * Filtering is client-side over the loader's window (≤ the choice
	 * limit, selected targets always included). Typing also triggers a
	 * debounced server round-trip via `?relationQuery=` so entries beyond
	 * the window are findable — same goto+keepFocus pattern as
	 * TableToolbar.svelte.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { X } from 'lucide-svelte';

	let {
		name,
		inputId,
		choices = [],
		value = [],
		multiple = false,
		total = 0,
	}: {
		/** Form field name for the hidden input (`r.<apiId>`). */
		name: string;
		/** Id for the visible text input, so the field label targets it. */
		inputId: string;
		choices?: { id: string; label: string }[];
		/** Initially selected target ids (order = position). */
		value?: string[];
		multiple?: boolean;
		/** Server-side total matching the current query, for the hint. */
		total?: number;
	} = $props();

	// Seeded once by design: the entry editor remounts this component per
	// record via its {#key data.entry?.id} wrapper, and in-progress picks
	// must survive the relationQuery navigations that replace `choices`.
	// svelte-ignore state_referenced_locally
	let selected = $state<string[]>([...value]);
	let query = $state('');
	let open = $state(false);
	let activeIndex = $state(0);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	// `name` is a per-field constant (the form field name), so deriving
	// ids from its initial value is intended.
	// svelte-ignore state_referenced_locally
	const listboxId = `${name}-listbox`;
	const optionId = (i: number) => `${name}-option-${i}`;

	// Labels accrete across server searches: a chip must keep its label
	// even after a narrower relationQuery drops its row from `choices`.
	let labelById = $state<Record<string, string>>({});
	$effect(() => {
		for (const c of choices) labelById[c.id] = c.label;
	});

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const pool = choices.filter((c) => !selected.includes(c.id));
		if (!q) return pool.slice(0, 50);
		return pool
			.filter(
				(c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
			)
			.slice(0, 50);
	});

	// Clamp the cursor when the result list shrinks under it.
	$effect(() => {
		if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
	});

	const truncated = $derived(total > choices.length);

	function pick(id: string) {
		if (multiple) {
			// Append — selection order is preserved and becomes `position`.
			selected = [...selected, id];
		} else {
			selected = [id];
			open = false;
		}
		query = '';
	}

	function remove(id: string) {
		selected = selected.filter((s) => s !== id);
	}

	function serverSearch(q: string) {
		// Server round-trip so entries beyond the loader's window become
		// findable. Debounced like TableToolbar's search; keepFocus so the
		// caret survives the navigation.
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			const url = new URL(page.url);
			if (q) url.searchParams.set('relationQuery', q);
			else url.searchParams.delete('relationQuery');
			goto(url, { keepFocus: true, noScroll: true });
		}, 300);
	}

	function onInput(event: Event) {
		query = (event.target as HTMLInputElement).value;
		open = true;
		activeIndex = 0;
		serverSearch(query.trim());
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			open = true;
			activeIndex = (activeIndex + 1) % Math.max(1, results.length);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			open = true;
			activeIndex = (activeIndex - 1 + results.length) % Math.max(1, results.length);
		} else if (event.key === 'Enter') {
			// Only intercept while the listbox is open — otherwise Enter
			// should submit the form as usual.
			if (open && results[activeIndex]) {
				event.preventDefault();
				pick(results[activeIndex].id);
			}
		} else if (event.key === 'Escape') {
			if (open) {
				event.preventDefault();
				open = false;
			}
		} else if (event.key === 'Backspace' && query === '' && selected.length > 0) {
			remove(selected[selected.length - 1]);
		}
	}
</script>

<div class="space-y-1.5">
	<!-- The single source of truth the form posts. Always present: an
	     empty value is how clearing reaches the save action. -->
	<input type="hidden" {name} value={selected.join(',')} />

	{#if selected.length > 0}
		<ul class="flex flex-wrap gap-1.5" aria-label="Selected">
			{#each selected as id (id)}
				<li
					class="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs"
				>
					<span class="max-w-56 truncate">{labelById[id] ?? id}</span>
					<button
						type="button"
						onclick={() => remove(id)}
						aria-label="Remove {labelById[id] ?? id}"
						class="grid h-4 w-4 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<X class="h-3 w-3" aria-hidden="true" />
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-xs text-muted-foreground">
			{multiple ? 'Nothing linked yet.' : 'None'}
		</p>
	{/if}

	<div class="relative">
		<input
			id={inputId}
			type="text"
			role="combobox"
			aria-expanded={open}
			aria-controls={listboxId}
			aria-autocomplete="list"
			aria-activedescendant={open && results[activeIndex]
				? optionId(activeIndex)
				: undefined}
			autocomplete="off"
			placeholder={choices.length === 0 && total === 0
				? 'No entries available to link yet'
				: 'Type to search…'}
			disabled={choices.length === 0 && total === 0 && !query}
			value={query}
			oninput={onInput}
			onkeydown={onKeydown}
			onfocus={() => (open = true)}
			onblur={() => (open = false)}
			class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		/>

		{#if open && results.length > 0}
			<!-- onmousedown preventDefault keeps the input's blur from
			     closing the list before the option's click lands. -->
			<ul
				id={listboxId}
				role="listbox"
				aria-label="Matching entries"
				onmousedown={(e) => e.preventDefault()}
				class="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
			>
				{#each results as choice, i (choice.id)}
					<li role="none">
						<button
							type="button"
							id={optionId(i)}
							role="option"
							aria-selected={i === activeIndex}
							onclick={() => pick(choice.id)}
							onmouseenter={() => (activeIndex = i)}
							class="w-full truncate rounded px-2 py-1.5 text-left text-sm {i === activeIndex
								? 'bg-accent text-accent-foreground'
								: 'text-foreground'}"
						>
							{choice.label}
						</button>
					</li>
				{/each}
			</ul>
		{:else if open && query.trim() && choices.length > 0}
			<ul
				id={listboxId}
				role="listbox"
				aria-label="Matching entries"
				class="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover p-1 shadow-lg"
			>
				<li class="px-2 py-1.5 text-sm text-muted-foreground" role="none">
					No matches.
				</li>
			</ul>
		{/if}
	</div>

	<p class="text-xs text-muted-foreground">
		{#if truncated}
			Showing {choices.length} of {total} — type to search all entries.
		{:else if multiple}
			Pick several; selection order is preserved.
		{:else}
			Pick one, or remove the chip for none.
		{/if}
	</p>
</div>
