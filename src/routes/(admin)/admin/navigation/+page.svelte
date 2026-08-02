<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Menu } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import type {
		NavigationMenuRecord,
		NavigationItemKind,
	} from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: {
			menus: NavigationMenuRecord[];
			targets: {
				pages: Array<{ id: string; slug: string; title: string }>;
				articles: Array<{ id: string; slug: string; title: string }>;
				categories: Array<{ id: string; slug: string; name: string }>;
				tags: Array<{ id: string; slug: string; name: string }>;
			};
		};
		form: { ok?: boolean; error?: string } | null;
	} = $props();

	let createMenuOpen = $state(false);
	let activeMenuId = $state<string | null>(data.menus[0]?.id ?? null);

	// Add-item form state, scoped to the active menu.
	let addLabelEn = $state('');
	let addLabelTh = $state('');
	let addKind = $state<NavigationItemKind>('page');
	let addTargetId = $state('');
	let addCustomUrl = $state('');

	const activeMenu = $derived(data.menus.find((mn) => mn.id === activeMenuId) ?? null);
	const items = $derived(
		(activeMenu?.items ?? [])
			.filter((it) => !it.parentId)
			.sort((a, b) => a.position - b.position),
	);

	function targetOptions() {
		switch (addKind) {
			case 'page':
				return data.targets.pages.map((p) => ({ id: p.id, label: `${p.title} (/${p.slug})` }));
			case 'article':
				return data.targets.articles.map((a) => ({ id: a.id, label: `${a.title} (/blog/${a.slug})` }));
			case 'category':
				return data.targets.categories.map((c) => ({ id: c.id, label: `${c.name} (?category=${c.slug})` }));
			case 'tag':
				return data.targets.tags.map((t) => ({ id: t.id, label: `${t.name} (?tag=${t.slug})` }));
			default:
				return [];
		}
	}

	function resetAdd() {
		addLabelEn = '';
		addLabelTh = '';
		addKind = 'page';
		addTargetId = '';
		addCustomUrl = '';
	}

	function itemDisplay(item: (typeof items)[number]): string {
		const labelEn = item.labels.en ?? item.labels.th ?? '(unlabeled)';
		const target =
			item.kind === 'custom'
				? item.customUrl
				: item.kind === 'page'
					? data.targets.pages.find((p) => p.id === item.targetId)?.slug
					: item.kind === 'article'
						? data.targets.articles.find((a) => a.id === item.targetId)?.slug
						: item.kind === 'category'
							? data.targets.categories.find((c) => c.id === item.targetId)?.slug
							: data.targets.tags.find((t) => t.id === item.targetId)?.slug;
		return `${labelEn} → ${item.kind}:${target ?? '?'}`;
	}
</script>

<svelte:head>
	<title>{m.cms_navigation()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="default" class="space-y-6">
	<PageHeader
		title={m.cms_navigation()}
		description={m.cms_navigation_help()}
		icon={Menu}
		class="mb-0"
	>
		{#snippet actions()}
			<Button
				type="button"
				variant="outline"
				onclick={() => (createMenuOpen = !createMenuOpen)}
			>
				{createMenuOpen ? m.cms_cancel() : m.cms_navigation_new_menu()}
			</Button>
		{/snippet}
	</PageHeader>

	{#if form?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">{form.error}</div>
	{/if}

	{#if createMenuOpen}
		<form
			method="POST"
			action="?/createMenu"
			use:enhance={() =>
				async ({ update, result }) => {
					await update();
					if (result.type === 'success') createMenuOpen = false;
				}}
			class="border border-border rounded-lg p-4 space-y-3 bg-muted/20"
		>
			<div class="grid sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_navigation_menu_key()}</span>
					<input name="key" required class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono" />
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.cms_navigation_menu_label()}</span>
					<input name="label" required class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm" />
				</label>
			</div>
			<Button type="submit">{m.cms_navigation_create_menu()}</Button>
		</form>
	{/if}

	<!-- Menu tabs -->
	<div class="flex gap-2 border-b border-border">
		{#each data.menus as menu (menu.id)}
			<button
				type="button"
				onclick={() => (activeMenuId = menu.id)}
				class="rounded-t-sm px-4 py-2 text-sm border-b-2 -mb-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {activeMenuId === menu.id ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}"
			>
				{menu.label}
				<span class="ml-1.5 text-xs text-muted-foreground">({menu.key})</span>
			</button>
		{/each}
	</div>

	{#if activeMenu}
		<!-- Items -->
		<div class="border border-border rounded-lg overflow-hidden">
			{#if items.length === 0}
				<div class="p-6 text-sm text-muted-foreground text-center">
					{m.cms_navigation_items_empty()}
				</div>
			{:else}
				<ul class="divide-y divide-border">
					{#each items as item, i (item.id)}
						<li class="flex items-center gap-2 px-4 py-2.5">
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium truncate">
									{item.labels.en ?? item.labels.th ?? '(unlabeled)'}
								</div>
								<div class="text-xs text-muted-foreground font-mono truncate">{itemDisplay(item)}</div>
							</div>
							<form method="POST" action="?/moveItem" use:enhance>
								<input type="hidden" name="id" value={item.id} />
								<input type="hidden" name="direction" value="up" />
								<Button
									type="submit"
									variant="ghost"
									size="sm"
									disabled={i === 0}
									class="px-1.5 text-muted-foreground"
									aria-label="Move up"
								>
									↑
								</Button>
							</form>
							<form method="POST" action="?/moveItem" use:enhance>
								<input type="hidden" name="id" value={item.id} />
								<input type="hidden" name="direction" value="down" />
								<Button
									type="submit"
									variant="ghost"
									size="sm"
									disabled={i === items.length - 1}
									class="px-1.5 text-muted-foreground"
									aria-label="Move down"
								>
									↓
								</Button>
							</form>
							<form
								method="POST"
								action="?/deleteItem"
								use:enhance={({ cancel }) => {
									if (!confirm(m.cms_delete_confirm())) {
										cancel();
										return;
									}
									return async ({ update }) => update();
								}}
							>
								<input type="hidden" name="id" value={item.id} />
								<Button type="submit" variant="ghost" size="sm" class="text-destructive">
									{m.cms_delete()}
								</Button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<!-- Add new item -->
		<form
			method="POST"
			action="?/addItem"
			use:enhance={() =>
				async ({ update, result }) => {
					await update();
					if (result.type === 'success') resetAdd();
				}}
			class="border border-border rounded-lg p-4 space-y-3 bg-muted/10"
		>
			<h3 class="text-sm font-semibold">{m.cms_navigation_add_item()}</h3>
			<input type="hidden" name="menu_id" value={activeMenu.id} />
			<div class="grid sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs font-medium">EN — {m.cms_navigation_label()}</span>
					<input name="label_en" bind:value={addLabelEn} required class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm" />
				</label>
				<label class="block">
					<span class="text-xs font-medium">TH — {m.cms_navigation_label()}</span>
					<input name="label_th" bind:value={addLabelTh} class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm" />
				</label>
			</div>
			<div class="grid sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_navigation_kind()}</span>
					<select name="kind" bind:value={addKind} class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm">
						<option value="page">page</option>
						<option value="article">article</option>
						<option value="category">category</option>
						<option value="tag">tag</option>
						<option value="custom">custom URL</option>
					</select>
				</label>
				{#if addKind === 'custom'}
					<label class="block">
						<span class="text-xs font-medium">{m.cms_navigation_custom_url()}</span>
						<input
							name="custom_url"
							bind:value={addCustomUrl}
							placeholder="https://…"
							class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
						/>
					</label>
				{:else}
					<label class="block">
						<span class="text-xs font-medium">{m.cms_navigation_target()}</span>
						<select
							name="target_id"
							bind:value={addTargetId}
							class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
						>
							<option value="">— {m.cms_navigation_pick()} —</option>
							{#each targetOptions() as opt (opt.id)}
								<option value={opt.id}>{opt.label}</option>
							{/each}
						</select>
					</label>
				{/if}
			</div>
			<Button type="submit">{m.cms_navigation_add_item()}</Button>
		</form>

		<!-- Delete menu (only allow when it's not one of the stock keys) -->
		{#if activeMenu.key !== 'primary' && activeMenu.key !== 'footer'}
			<form
				method="POST"
				action="?/deleteMenu"
				use:enhance={({ cancel }) => {
					if (!confirm(m.cms_delete_confirm())) {
						cancel();
						return;
					}
					return async ({ update }) => update();
				}}
			>
				<input type="hidden" name="id" value={activeMenu.id} />
				<Button
					type="submit"
					variant="outline"
					size="sm"
					class="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
				>
					{m.cms_navigation_delete_menu()}
				</Button>
			</form>
		{/if}
	{/if}
</PageShell>
