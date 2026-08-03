<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Package, Plus, Archive, Trash2 } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		DataTable,
		TableToolbar,
		StatusBadge,
		type Column
	} from '$lib/components/admin';
	import * as m from '$lib/paraglide/messages';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Product = PageData['products'][number];

	const filters = [
		{
			param: 'status',
			label: m.cms_filter_status(),
			options: ['draft', 'active', 'archived'].map((s) => ({
				value: s,
				label: s[0].toUpperCase() + s.slice(1)
			}))
		}
	];

	const columns: Column<Product>[] = [
		{ key: 'title', header: 'Title', cell: titleCell },
		{ key: 'slug', header: 'Slug', cell: slugCell },
		{ key: 'status', header: 'Status', cell: statusCell },
		{ key: 'price', header: 'Price from', align: 'right', numeric: true, cell: priceCell },
		{ key: 'stock', header: 'Stock', cell: stockCell },
		{ key: 'actions', header: '', align: 'right', class: 'w-32', cell: actionsCell }
	];
</script>

{#snippet titleCell(product: Product)}
	<a
		href={resolve('/(admin)/admin/shop/products/[id]', { id: product.id })}
		class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{product.title}
	</a>
{/snippet}

{#snippet slugCell(product: Product)}
	<code class="text-xs text-muted-foreground">{product.slug}</code>
{/snippet}

{#snippet statusCell(product: Product)}
	<StatusBadge status={product.status} />
{/snippet}

{#snippet priceCell(product: Product)}
	{product.priceFromSatang != null ? formatSatang(product.priceFromSatang as Satang) : '—'}
{/snippet}

{#snippet stockCell(product: Product)}
	{#if product.inStock}
		<StatusBadge status="active" tone="success" label="In stock" />
	{:else}
		<StatusBadge status="out" tone="danger" label="Out" />
	{/if}
{/snippet}

{#snippet actionsCell(product: Product)}
	<div class="flex justify-end gap-1">
		{#if product.status !== 'archived'}
			<form method="POST" action="?/archive" use:enhance class="inline">
				<input type="hidden" name="id" value={product.id} />
				<Button type="submit" variant="ghost" size="sm" title="Archive">
					<Archive class="h-4 w-4" />
				</Button>
			</form>
		{/if}
		<form
			method="POST"
			action="?/delete"
			use:enhance={() => async ({ update }) => {
				if (!confirm(`Delete "${product.title}"? This is permanent.`)) return;
				await update();
			}}
			class="inline"
		>
			<input type="hidden" name="id" value={product.id} />
			<Button type="submit" variant="ghost" size="sm" title="Delete" class="text-destructive">
				<Trash2 class="h-4 w-4" />
			</Button>
		</form>
	</div>
{/snippet}

<PageShell width="wide">
	<PageHeader title="Products" icon={Package}>
		{#snippet actions()}
			<Button href={resolve('/(admin)/admin/shop/products/new')}>
				<Plus class="h-4 w-4" />
				New product
			</Button>
		{/snippet}
	</PageHeader>

	<TableToolbar searchPlaceholder={m.shop_search_products()} {filters} />

	<DataTable {columns} rows={data.products} getKey={(p) => p.id}>
		{#snippet empty()}
			{#if data.search || data.statusFilter}
				<!-- A search matching nothing must not read as "you have no products". -->
				<p class="text-sm text-muted-foreground">{m.admin_no_results()}</p>
			{:else}
				<p class="mb-4 text-sm text-muted-foreground">No products yet.</p>
				<Button href={resolve('/(admin)/admin/shop/products/new')}>
					<Plus class="h-4 w-4" />
					Create your first product
				</Button>
			{/if}
		{/snippet}
	</DataTable>
</PageShell>
