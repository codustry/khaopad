<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Package, Plus, Archive, Trash2 } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		DataTable,
		TableToolbar,
		StatusBadge,
		type Column,
		type SortDirection
	} from '$lib/components/admin';
	import * as m from '$lib/paraglide/messages';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Product = PageData['products'][number];

	let selected = $state<string[]>([]);

	// Archive/delete are admin-only server-side; hide the buttons from
	// editors so the bulk bar never offers an action that 403s.
	const isAdmin = $derived(
		page.data.user?.role === 'admin' || page.data.user?.role === 'super_admin'
	);

	// Row set changes (filter, search, sort, mutation) invalidate the
	// selection — a hidden selected row would silently receive bulk ops.
	$effect(() => {
		const visible = new Set(data.products.map((p) => p.id));
		if (selected.some((id) => !visible.has(id))) {
			selected = selected.filter((id) => visible.has(id));
		}
	});

	function onSort(key: string, dir: SortDirection) {
		const url = new URL(page.url);
		url.searchParams.set('sort', key);
		url.searchParams.set('dir', dir);
		// Current route + new query params — no route ID exists to
		// resolve() (same case as TableToolbar's navigateWith).
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(url, { noScroll: true });
	}

	const filters = [
		{
			param: 'status',
			label: m.cms_filter_status(),
			options: [
				{ value: 'draft', label: m.status_draft() },
				{ value: 'active', label: m.shop_admin_status_active() },
				{ value: 'archived', label: m.status_archived() }
			]
		}
	];

	const columns: Column<Product>[] = [
		{ key: 'title', header: m.shop_admin_col_title(), sortable: true, cell: titleCell },
		{ key: 'slug', header: m.shop_admin_col_slug(), cell: slugCell },
		{ key: 'status', header: m.cms_filter_status(), sortable: true, cell: statusCell },
		{
			key: 'price',
			header: m.shop_admin_price_from(),
			align: 'right',
			numeric: true,
			sortable: true,
			cell: priceCell
		},
		{ key: 'stock', header: m.shop_admin_col_stock(), cell: stockCell },
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
		<StatusBadge status="active" tone="success" label={m.shop_admin_in_stock()} />
	{:else}
		<StatusBadge status="out" tone="danger" label={m.shop_admin_out_of_stock()} />
	{/if}
{/snippet}

{#snippet actionsCell(product: Product)}
	<div class="flex justify-end gap-1">
		{#if product.status !== 'archived'}
			<form method="POST" action="?/archive" use:enhance class="inline">
				<input type="hidden" name="id" value={product.id} />
				<Button type="submit" variant="ghost" size="sm" title={m.shop_admin_archive()}>
					<Archive class="h-4 w-4" />
				</Button>
			</form>
		{/if}
		<form
			method="POST"
			action="?/delete"
			use:enhance={() => async ({ update }) => {
				if (!confirm(m.shop_admin_delete_confirm_permanent({ title: product.title }))) return;
				await update();
			}}
			class="inline"
		>
			<input type="hidden" name="id" value={product.id} />
			<Button type="submit" variant="ghost" size="sm" title={m.shop_admin_delete()} class="text-destructive">
				<Trash2 class="h-4 w-4" />
			</Button>
		</form>
	</div>
{/snippet}

<PageShell width="wide">
	<PageHeader title={m.shop_admin_products()} icon={Package}>
		{#snippet actions()}
			<Button href={resolve('/(admin)/admin/shop/products/new')}>
				<Plus class="h-4 w-4" />
				{m.shop_admin_new_product()}
			</Button>
		{/snippet}
	</PageHeader>

	<TableToolbar
		searchPlaceholder={m.shop_search_products()}
		{filters}
		selectedCount={selected.length}
		onClearSelection={() => (selected = [])}
	>
		{#snippet bulkActions()}
			<!-- Status flips: editor+. One form per op, ids as repeated fields. -->
			<form
				method="POST"
				action="?/bulk"
				use:enhance={() => async ({ update }) => {
					selected = [];
					await update();
				}}
				class="inline"
			>
				{#each selected as id (id)}<input type="hidden" name="ids" value={id} />{/each}
				<input type="hidden" name="op" value="activate" />
				<Button type="submit" variant="outline" size="sm">{m.admin_bulk_set_active()}</Button>
			</form>
			<form
				method="POST"
				action="?/bulk"
				use:enhance={() => async ({ update }) => {
					selected = [];
					await update();
				}}
				class="inline"
			>
				{#each selected as id (id)}<input type="hidden" name="ids" value={id} />{/each}
				<input type="hidden" name="op" value="draft" />
				<Button type="submit" variant="outline" size="sm">{m.admin_bulk_set_draft()}</Button>
			</form>
			{#if isAdmin}
				<form
					method="POST"
					action="?/bulk"
					use:enhance={() => async ({ update }) => {
						selected = [];
						await update();
					}}
					class="inline"
				>
					{#each selected as id (id)}<input type="hidden" name="ids" value={id} />{/each}
					<input type="hidden" name="op" value="archive" />
					<Button type="submit" variant="outline" size="sm">
						<Archive class="h-4 w-4" />
						{m.admin_bulk_archive()}
					</Button>
				</form>
				<!--
					Typed-confirm: deleting N products is unrecoverable, so the
					admin must type the selection count. The server re-checks
					`confirmCount` against the id list.
				-->
				<form
					method="POST"
					action="?/bulk"
					use:enhance={({ cancel, formData }) => {
						const count = selected.length;
						const typed = prompt(m.admin_bulk_delete_prompt({ count }));
						if (typed?.trim() !== String(count)) {
							cancel();
							return;
						}
						formData.set('confirmCount', String(count));
						return async ({ update }) => {
							selected = [];
							await update();
						};
					}}
					class="inline"
				>
					{#each selected as id (id)}<input type="hidden" name="ids" value={id} />{/each}
					<input type="hidden" name="op" value="delete" />
					<Button type="submit" variant="outline" size="sm" class="text-destructive">
						<Trash2 class="h-4 w-4" />
						{m.admin_bulk_delete()}
					</Button>
				</form>
			{/if}
		{/snippet}
	</TableToolbar>

	<DataTable
		{columns}
		rows={data.products}
		getKey={(p) => p.id}
		selectable
		{selected}
		onSelectionChange={(keys) => (selected = keys)}
		sortKey={data.sort ?? undefined}
		sortDir={data.dir}
		{onSort}
	>
		{#snippet empty()}
			{#if data.search || data.statusFilter}
				<!-- A search matching nothing must not read as "you have no products". -->
				<p class="text-sm text-muted-foreground">{m.admin_no_results()}</p>
			{:else}
				<p class="mb-4 text-sm text-muted-foreground">{m.shop_admin_no_products()}</p>
				<Button href={resolve('/(admin)/admin/shop/products/new')}>
					<Plus class="h-4 w-4" />
					{m.shop_admin_create_first_product()}
				</Button>
			{/if}
		{/snippet}
	</DataTable>
</PageShell>
