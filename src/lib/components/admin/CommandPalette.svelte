<script lang="ts">
	/**
	 * ⌘K navigation palette.
	 *
	 * Reads the same nav registry the sidebar does, so a plugin that
	 * registers a nav item gets palette entries for free and the two can
	 * never disagree about what exists.
	 *
	 * ## Scoring
	 *
	 * Prefix match beats word-boundary match beats substring, so typing
	 * "art" puts "Articles" above "Smart fields". Deliberately not fuzzy
	 * subsequence matching: on a list this small (a few dozen entries)
	 * fuzzy matching mostly surfaces surprising results, and predictable
	 * beats clever for something people learn by muscle memory.
	 *
	 * ## Roles
	 *
	 * Entries are filtered by the signed-in user's role before display.
	 * Showing a super-admin-only page to an editor would produce a 403 on
	 * navigation — a broken-looking product, and a small information leak
	 * about what exists.
	 */
	import { goto } from '$app/navigation';
	import { listNavGroups, type NavItem } from './sidebar-nav';
	import * as m from '$lib/paraglide/messages';
	import { Search } from 'lucide-svelte';
	import { onMount, tick } from 'svelte';

	let {
		role
	}: {
		role?: string | null;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let activeIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	type Entry = { item: NavItem; group: string };

	const entries = $derived.by<Entry[]>(() =>
		listNavGroups().flatMap((group) =>
			group.items
				.filter((item) => !item.roles?.length || (role && item.roles.includes(role as never)))
				.map((item) => ({ item, group: group.title() }))
		)
	);

	function score(label: string, q: string): number {
		const l = label.toLowerCase();
		if (l.startsWith(q)) return 0;
		// Word-boundary match: "media" should rank for "Social media".
		if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l)) return 1;
		if (l.includes(q)) return 2;
		return -1;
	}

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries.slice(0, 12);
		return entries
			.map((entry) => ({ entry, rank: score(entry.item.label(), q) }))
			.filter((x) => x.rank >= 0)
			.sort((a, b) => a.rank - b.rank)
			.slice(0, 12)
			.map((x) => x.entry);
	});

	// Clamps the cursor when the result list shrinks under it, which
	// otherwise leaves Enter pointing at nothing.
	$effect(() => {
		if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
	});

	async function show() {
		open = true;
		query = '';
		activeIndex = 0;
		await tick();
		inputEl?.focus();
	}

	function hide() {
		open = false;
	}

	function select(entry: Entry) {
		hide();
		// `href` comes from the nav registry, where it is already a typed
		// `Pathname` produced by SvelteKit — resolving it again here would
		// double-apply the base path.
		goto(entry.item.href);
	}

	onMount(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				if (open) hide();
				else show();
				return;
			}
			if (!open) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				hide();
			} else if (event.key === 'ArrowDown') {
				event.preventDefault();
				activeIndex = (activeIndex + 1) % Math.max(1, results.length);
			} else if (event.key === 'ArrowUp') {
				event.preventDefault();
				activeIndex = (activeIndex - 1 + results.length) % Math.max(1, results.length);
			} else if (event.key === 'Enter' && results[activeIndex]) {
				event.preventDefault();
				select(results[activeIndex]);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

{#if open}
	<!--
		The backdrop is a plain div with a sibling close button rather than
		an interactive div: a div with onclick is invisible to keyboard and
		screen-reader users, and this needs a real focusable escape hatch.
	-->
	<div class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]">
		<button type="button" class="absolute inset-0 cursor-default" aria-label="Close" onclick={hide}
		></button>

		<div
			role="dialog"
			aria-modal="true"
			aria-label={m.admin_command_palette()}
			class="relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
		>
			<div class="flex items-center gap-2 border-b border-border px-3">
				<Search class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<input
					bind:this={inputEl}
					bind:value={query}
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls="command-results"
					aria-activedescendant={results[activeIndex]
						? `command-option-${activeIndex}`
						: undefined}
					placeholder={m.admin_command_search()}
					class="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
				/>
			</div>

			{#if results.length === 0}
				<p class="px-4 py-6 text-center text-sm text-muted-foreground">
					{m.admin_command_empty()}
				</p>
			{:else}
				<ul id="command-results" role="listbox" class="max-h-80 overflow-y-auto p-1">
					{#each results as entry, i (entry.item.href)}
						{@const Icon = entry.item.icon}
						<li role="none">
							<button
								type="button"
								id="command-option-{i}"
								role="option"
								aria-selected={i === activeIndex}
								onclick={() => select(entry)}
								onmouseenter={() => (activeIndex = i)}
								class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm {i ===
								activeIndex
									? 'bg-accent text-accent-foreground'
									: 'text-foreground'}"
							>
								<Icon class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span class="flex-1 truncate">{entry.item.label()}</span>
								<span class="shrink-0 text-xs text-muted-foreground">{entry.group}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}
