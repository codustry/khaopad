<script lang="ts">
	import { enhance } from '$app/forms';
	import { Boxes } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let createOpen = $state(false);

	type Collection = PageData['collections'][number];

	const columns: Column<Collection>[] = [
		{ key: 'title', header: 'Title', cell: titleCell },
		{ key: 'slug', header: 'Slug', cell: slugCell },
		{ key: 'status', header: 'Status', cell: statusCell },
		{ key: 'productCount', header: 'Products', align: 'right', numeric: true }
	];
</script>

{#snippet titleCell(c: Collection)}
	<span class="font-medium">{c.title || '(untitled)'}</span>
{/snippet}

{#snippet slugCell(c: Collection)}
	<span class="font-mono text-xs text-muted-foreground">{c.slug}</span>
{/snippet}

{#snippet statusCell(c: Collection)}
	<StatusBadge status={c.status} />
{/snippet}

<svelte:head><title>Collections — Khao Pad CMS</title></svelte:head>

<PageShell width="wide">
	<PageHeader
		title="Collections"
		description="Group products for storefront browsing."
		icon={Boxes}
	>
		{#snippet actions()}
			<Button variant={createOpen ? 'outline' : 'default'} onclick={() => (createOpen = !createOpen)}>
				{createOpen ? 'Cancel' : 'New collection'}
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
				Collection created.
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
						<label for="titleEn" class="text-sm font-medium">Title (English)</label>
						<input
							id="titleEn"
							name="titleEn"
							required
							value={form?.values?.titleEn ?? ''}
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						/>
						<p class="mt-1 text-xs text-muted-foreground">
							Required — the slug is derived from this.
						</p>
					</div>
					<div>
						<label for="titleTh" class="text-sm font-medium">Title (Thai)</label>
						<input
							id="titleTh"
							name="titleTh"
							value={form?.values?.titleTh ?? ''}
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						/>
					</div>
					<div>
						<label for="slug" class="text-sm font-medium">Slug</label>
						<input
							id="slug"
							name="slug"
							placeholder="auto from English title"
							value={form?.values?.slug ?? ''}
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						/>
					</div>
					<div>
						<label for="status" class="text-sm font-medium">Status</label>
						<select
							id="status"
							name="status"
							class="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:text-sm"
						>
							<option value="draft">Draft</option>
							<option value="active">Active</option>
						</select>
					</div>
				</div>

				{#if data.products.length > 0}
					<fieldset>
						<legend class="text-sm font-medium">Products</legend>
						<p class="mb-2 text-xs text-muted-foreground">
							Optional — products can be added now or later.
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
						No products yet — create some first to populate a collection.
					</p>
				{/if}

				<Button type="submit">Create collection</Button>
			</form>
		{/if}

		<DataTable {columns} rows={data.collections} getKey={(c) => c.id}>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">
					No collections yet. Create one to group products on the storefront.
				</p>
			{/snippet}
		</DataTable>
	</div>
</PageShell>
