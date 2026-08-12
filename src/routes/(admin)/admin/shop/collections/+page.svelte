<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Boxes } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import * as m from '$lib/paraglide/messages';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let createOpen = $state(false);

	type Collection = PageData['collections'][number];

	const columns: Column<Collection>[] = [
		{ key: 'title', header: m.shop_admin_col_title(), cell: titleCell },
		{ key: 'slug', header: m.shop_admin_col_slug(), cell: slugCell },
		{ key: 'status', header: m.cms_filter_status(), cell: statusCell },
		{
			key: 'productCount',
			header: m.shop_admin_col_products(),
			align: 'right',
			numeric: true,
			cell: productCountCell
		}
	];
</script>

<!-- Both the title and the count open the collection: before the [id]
     route existed the index was a dead end, and a count is exactly the
     thing you click to see what is behind it. -->
{#snippet titleCell(c: Collection)}
	<a
		href={resolve('/(admin)/admin/shop/collections/[id]', { id: c.id })}
		class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{c.title || m.shop_admin_untitled()}
	</a>
{/snippet}

{#snippet productCountCell(c: Collection)}
	<a
		href={resolve('/(admin)/admin/shop/collections/[id]', { id: c.id })}
		class="rounded-sm tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{c.productCount}
	</a>
{/snippet}

{#snippet slugCell(c: Collection)}
	<span class="font-mono text-xs text-muted-foreground">{c.slug}</span>
{/snippet}

{#snippet statusCell(c: Collection)}
	<StatusBadge status={c.status} />
{/snippet}

<svelte:head><title>{m.shop_admin_collections()} — {m.cms_app_name()}</title></svelte:head>

<PageShell width="wide">
	<PageHeader
		title={m.shop_admin_collections()}
		description={m.shop_admin_collections_desc()}
		icon={Boxes}
	>
		{#snippet actions()}
			<Button variant={createOpen ? 'outline' : 'default'} onclick={() => (createOpen = !createOpen)}>
				{createOpen ? m.shop_admin_cancel() : m.shop_admin_new_collection()}
			</Button>
		{/snippet}
	</PageHeader>

	<div class="space-y-4">
		{#if form?.error}
			<div
				class="rounded-md border border-red-300 bg-red-100 p-3 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300"
			>
				{form.error}
			</div>
		{:else if form?.success}
			<div
				class="rounded-md border border-green-300 bg-green-100 p-3 text-sm text-green-800 dark:border-green-500/40 dark:bg-green-500/15 dark:text-green-300"
			>
				{m.shop_admin_collection_created()}
			</div>
		{/if}

		{#if createOpen}
			<form
				method="POST"
				action="?/create"
				use:enhance={() => async ({ update }) => {
					await update();
					createOpen = false;
				}}
				class="space-y-4 rounded-lg border border-border p-4"
			>
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label for="titleEn" class="text-sm font-medium">{m.shop_admin_title_en()}</label>
						<input
							id="titleEn"
							name="titleEn"
							required
							value={form?.values?.titleEn ?? ''}
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						/>
						<p class="mt-1 text-xs text-muted-foreground">
							{m.shop_admin_title_en_help()}
						</p>
					</div>
					<div>
						<label for="titleTh" class="text-sm font-medium">{m.shop_admin_title_th()}</label>
						<input
							id="titleTh"
							name="titleTh"
							value={form?.values?.titleTh ?? ''}
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						/>
					</div>
					<div>
						<label for="slug" class="text-sm font-medium">{m.shop_admin_slug()}</label>
						<input
							id="slug"
							name="slug"
							placeholder={m.shop_admin_slug_placeholder()}
							value={form?.values?.slug ?? ''}
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						/>
					</div>
					<div>
						<label for="status" class="text-sm font-medium">{m.cms_filter_status()}</label>
						<select
							id="status"
							name="status"
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						>
							<option value="draft">{m.status_draft()}</option>
							<option value="active">{m.shop_admin_status_active()}</option>
						</select>
					</div>
				</div>

				{#if data.products.length > 0}
					<fieldset>
						<legend class="text-sm font-medium">{m.shop_admin_col_products()}</legend>
						<p class="mb-2 text-xs text-muted-foreground">
							{m.shop_admin_products_optional_help()}
						</p>
						<div class="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
							{#each data.products as p (p.id)}
								<label class="flex items-center gap-2 text-sm">
									<input type="checkbox" name="productIds" value={p.id} />
									<span>{p.title || p.slug}</span>
								</label>
							{/each}
						</div>
					</fieldset>
				{:else}
					<p class="text-xs text-muted-foreground">
						{m.shop_admin_no_products_for_collection()}
					</p>
				{/if}

				<Button type="submit">{m.shop_admin_create_collection()}</Button>
			</form>
		{/if}

		<DataTable {columns} rows={data.collections} getKey={(c) => c.id}>
			{#snippet empty()}
				<!-- The New button lives in the page header, far from where
				     the eye lands on an empty table — so the empty state
				     carries its own CTA. -->
				<div class="space-y-3 py-2">
					<p class="text-sm text-muted-foreground">
						{m.shop_admin_no_collections()}
					</p>
					{#if !createOpen}
						<Button size="sm" onclick={() => (createOpen = true)}>
							{m.shop_admin_new_collection()}
						</Button>
					{/if}
				</div>
			{/snippet}
		</DataTable>
	</div>
</PageShell>
