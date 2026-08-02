<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Package, Trash2 } from 'lucide-svelte';
	import { Button, Badge, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const product = $derived(data.product);
	const enTitle = $derived(product.localizations['en']?.title ?? product.slug);

	type Variant = PageData['product']['variants'][number];

	const variantColumns: Column<Variant>[] = [
		{ key: 'title', header: 'Title', cell: variantTitleCell },
		{ key: 'sku', header: 'SKU', cell: skuCell },
		{ key: 'price', header: 'Price', align: 'right', numeric: true, cell: priceCell },
		{ key: 'onHand', header: 'On hand', align: 'right', numeric: true, cell: onHandCell },
		{ key: 'reserved', header: 'Reserved', align: 'right', numeric: true, cell: reservedCell },
		{ key: 'available', header: 'Available', align: 'right', numeric: true, cell: availableCell },
		{ key: 'adjust', header: 'Adjust inventory', class: 'w-40', cell: adjustCell }
	];
</script>

{#snippet variantTitleCell(variant: Variant)}
	<span class="font-medium">{variant.titleCached || 'Default'}</span>
	{#if variant.status === 'archived'}
		<Badge variant="outline" class="ml-2">archived</Badge>
	{/if}
{/snippet}

{#snippet skuCell(variant: Variant)}
	<code class="text-xs text-muted-foreground">{variant.sku ?? '—'}</code>
{/snippet}

{#snippet priceCell(variant: Variant)}
	{formatSatang(variant.priceSatang as Satang)}
{/snippet}

{#snippet onHandCell(variant: Variant)}
	{variant.inventory?.onHand ?? '—'}
{/snippet}

{#snippet reservedCell(variant: Variant)}
	{variant.inventory?.reserved ?? '—'}
{/snippet}

{#snippet availableCell(variant: Variant)}
	{#if variant.inventory}
		<span
			class={variant.inventory.available > 0
				? 'text-green-700 dark:text-green-400'
				: 'text-destructive'}
		>
			{variant.inventory.available}
		</span>
	{:else}
		—
	{/if}
{/snippet}

{#snippet adjustCell(variant: Variant)}
	<form method="POST" action="?/adjustInventory" use:enhance class="flex gap-1">
		<input type="hidden" name="variantId" value={variant.id} />
		<Input type="number" name="delta" placeholder="±N" class="h-8 w-20 text-xs" />
		<Button type="submit" size="sm" variant="outline">Apply</Button>
	</form>
{/snippet}

<PageShell>
	<PageHeader
		title={enTitle}
		description={product.slug}
		icon={Package}
		breadcrumbs={[
			{ label: 'Products', href: resolve('/(admin)/admin/shop/products') },
			{ label: enTitle }
		]}
	>
		{#snippet actions()}
			<StatusBadge status={product.status} />
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div
				class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
			>
				{form.error}
			</div>
		{/if}
		{#if form?.success && form.message}
			<div
				class="rounded-md border border-green-600/50 bg-green-100 p-3 text-sm text-green-800 dark:bg-green-500/15 dark:text-green-300"
			>
				{form.message}
			</div>
		{/if}

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Localizations
			</h2>
			<div class="space-y-3">
				{#each Object.entries(product.localizations) as [locale, loc] (locale)}
					<div>
						<div class="mb-1 flex items-center gap-2">
							<Badge variant="outline">{locale}</Badge>
							<span class="font-medium">{loc.title}</span>
						</div>
						{#if loc.descriptionMarkdown}
							<div class="ml-14 line-clamp-3 text-sm text-muted-foreground">
								{loc.descriptionMarkdown}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>

		<section class="space-y-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Variants ({product.variants.length})
			</h2>
			<DataTable columns={variantColumns} rows={product.variants} getKey={(v) => v.id}>
				{#snippet empty()}
					<p class="text-sm text-muted-foreground">No variants.</p>
				{/snippet}
			</DataTable>
		</section>

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Status</h2>
			<form method="POST" action="?/setStatus" use:enhance class="flex items-center gap-3">
				<Label for="status" class="sr-only">Status</Label>
				<select
					id="status"
					name="status"
					value={product.status}
					class="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					<option value="draft">Draft (invisible to public)</option>
					<option value="active">Active (published)</option>
					<option value="archived">Archived (hidden, admin+ only)</option>
				</select>
				<Button type="submit" size="sm">Update</Button>
			</form>
		</section>

		<section class="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-destructive">Danger zone</h2>
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-sm font-medium">Delete this product</p>
					<p class="text-xs text-muted-foreground">
						Cascades to variants, options, and inventory. Cart/order rows referencing this product
						will show as "Product no longer available" after v3.2 lands.
					</p>
				</div>
				<form
					method="POST"
					action="?/delete"
					use:enhance={() => async ({ update }) => {
						if (!confirm(`Delete "${enTitle}"? This cannot be undone.`)) return;
						await update();
					}}
				>
					<Button type="submit" variant="destructive" size="sm">
						<Trash2 class="mr-2 h-4 w-4" />
						Delete
					</Button>
				</form>
			</div>
		</section>
	</div>
</PageShell>
