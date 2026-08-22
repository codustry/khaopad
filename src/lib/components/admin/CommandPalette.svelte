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
	 *
	 * ## Content search (#160 C7)
	 *
	 * Queries of 2+ characters also hit GET /api/admin/search (debounced
	 * 250 ms), and matching orders / products / articles render in
	 * headed groups BELOW the nav matches. The same role predicate the
	 * nav filter uses gates each content group client-side (mirroring
	 * the shop nav registration); the endpoint enforces it again
	 * server-side.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { listNavGroups, type NavItem } from './sidebar-nav';
	import * as m from '$lib/paraglide/messages';
	import { FileText, Package, Search, ShoppingCart } from 'lucide-svelte';
	import { onMount, tick } from 'svelte';
	import type { ComponentType } from 'svelte';

	let {
		role,
		enabledPlugins = []
	}: {
		role?: string | null;
		/**
		 * Opt-in plugin slugs (#193). The palette reads the same registry
		 * as the sidebar, so it must apply the same gate — otherwise ⌘K
		 * would still offer "Products" on a site where Shop is off, and
		 * navigating there would 404.
		 */
		enabledPlugins?: ReadonlyArray<string>;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let activeIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	type Entry = { item: NavItem; group: string };

	/** The nav registry's role predicate — shared with content groups. */
	function roleAllows(roles: ReadonlyArray<string> | undefined): boolean {
		return !roles?.length || Boolean(role && roles.includes(role));
	}

	const entries = $derived.by<Entry[]>(() =>
		listNavGroups(enabledPlugins).flatMap((group) =>
			group.items
				.filter((item) => roleAllows(item.roles))
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

	// ── Content search ──────────────────────────────────────

	/** Debounce before hitting /api/admin/search. */
	const SEARCH_DEBOUNCE_MS = 250;
	/** Below this the endpoint returns nothing anyway — don't fetch. */
	const SEARCH_MIN_CHARS = 2;

	// Same role lists the shop plugin registers its nav items with —
	// orders is an admin+ route, products is editor+.
	const ORDER_ROLES = ['super_admin', 'admin'] as const;
	const PRODUCT_ROLES = ['super_admin', 'admin', 'editor'] as const;

	type ContentHit = {
		href: string;
		label: string;
		detail: string;
		section: string;
		icon: ComponentType;
	};

	type SearchResponse = {
		orders: Array<{ id: string; orderNumber: string; email: string; status: string }>;
		products: Array<{ id: string; title: string; slug: string; status: string }>;
		articles: Array<{ id: string; title: string }>;
	};

	let contentHits = $state<ContentHit[]>([]);
	let searchToken = 0;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const q = query.trim();
		clearTimeout(searchTimer);
		if (!open || q.length < SEARCH_MIN_CHARS) {
			searchToken++; // invalidate any in-flight response
			contentHits = [];
			return;
		}
		const token = ++searchToken;
		searchTimer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/admin/search?q=${encodeURIComponent(q)}`);
				if (!res.ok) return;
				const data = (await res.json()) as SearchResponse;
				// A newer keystroke owns the palette now — drop this response.
				if (token !== searchToken) return;
				const hits: ContentHit[] = [];
				if (roleAllows(ORDER_ROLES)) {
					for (const o of data.orders) {
						hits.push({
							href: resolve('/(admin)/admin/shop/orders/[id]', { id: o.id }),
							label: o.orderNumber,
							detail: o.email,
							section: m.admin_palette_group_orders(),
							icon: ShoppingCart
						});
					}
				}
				if (roleAllows(PRODUCT_ROLES)) {
					for (const p of data.products) {
						hits.push({
							href: resolve('/(admin)/admin/shop/products/[id]', { id: p.id }),
							label: p.title,
							detail: p.slug,
							section: m.admin_palette_group_products(),
							icon: Package
						});
					}
				}
				for (const a of data.articles) {
					hits.push({
						href: resolve('/(admin)/admin/articles/[id]', { id: a.id }),
						label: a.title,
						detail: '',
						section: m.admin_palette_group_articles(),
						icon: FileText
					});
				}
				contentHits = hits;
			} catch {
				// Network hiccup — the nav matches still work.
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(searchTimer);
	});

	// One flat selectable list: nav matches first, content hits below.
	type Row =
		| { kind: 'nav'; entry: Entry }
		| { kind: 'hit'; hit: ContentHit };

	const rows = $derived.by<Row[]>(() => [
		...results.map((entry) => ({ kind: 'nav', entry }) as Row),
		...contentHits.map((hit) => ({ kind: 'hit', hit }) as Row)
	]);

	// Clamps the cursor when the result list shrinks under it, which
	// otherwise leaves Enter pointing at nothing.
	$effect(() => {
		if (activeIndex >= rows.length) activeIndex = Math.max(0, rows.length - 1);
	});

	async function show() {
		open = true;
		query = '';
		activeIndex = 0;
		contentHits = [];
		await tick();
		inputEl?.focus();
	}

	function hide() {
		open = false;
	}

	function select(row: Row) {
		hide();
		// Nav `href` comes from the nav registry, where it is already a
		// typed `Pathname` produced by SvelteKit; content hit hrefs are
		// built with resolve() above. Resolving again here would
		// double-apply the base path.
		goto(row.kind === 'nav' ? row.entry.item.href : row.hit.href);
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
				activeIndex = (activeIndex + 1) % Math.max(1, rows.length);
			} else if (event.key === 'ArrowUp') {
				event.preventDefault();
				activeIndex = (activeIndex - 1 + rows.length) % Math.max(1, rows.length);
			} else if (event.key === 'Enter' && rows[activeIndex]) {
				event.preventDefault();
				select(rows[activeIndex]);
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
					aria-activedescendant={rows[activeIndex]
						? `command-option-${activeIndex}`
						: undefined}
					placeholder={m.admin_command_search()}
					class="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
				/>
			</div>

			{#if rows.length === 0}
				<p class="px-4 py-6 text-center text-sm text-muted-foreground">
					{m.admin_command_empty()}
				</p>
			{:else}
				<ul id="command-results" role="listbox" class="max-h-80 overflow-y-auto p-1">
					{#each rows as row, i (row.kind === 'nav' ? `nav:${row.entry.item.href}` : `hit:${row.hit.href}`)}
						{#if row.kind === 'hit' && (i === 0 || rows[i - 1].kind === 'nav' || (rows[i - 1] as { kind: 'hit'; hit: ContentHit }).hit.section !== row.hit.section)}
							<li
								role="presentation"
								class="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								{row.hit.section}
							</li>
						{/if}
						{@const Icon = row.kind === 'nav' ? row.entry.item.icon : row.hit.icon}
						<li role="none">
							<button
								type="button"
								id="command-option-{i}"
								role="option"
								aria-selected={i === activeIndex}
								onclick={() => select(row)}
								onmouseenter={() => (activeIndex = i)}
								class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm {i ===
								activeIndex
									? 'bg-accent text-accent-foreground'
									: 'text-foreground'}"
							>
								<Icon class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								{#if row.kind === 'nav'}
									<span class="flex-1 truncate">{row.entry.item.label()}</span>
									<span class="shrink-0 text-xs text-muted-foreground">{row.entry.group}</span>
								{:else}
									<span class="flex-1 truncate">{row.hit.label}</span>
									{#if row.hit.detail}
										<span class="shrink-0 text-xs text-muted-foreground">{row.hit.detail}</span>
									{/if}
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}
