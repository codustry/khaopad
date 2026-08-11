<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ShoppingCart } from 'lucide-svelte';
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

	type Order = PageData['orders'][number];

	const filters = [
		{
			param: 'status',
			label: m.cms_filter_status(),
			options: [
				{ value: 'pending', label: m.shop_status_pending() },
				{ value: 'paid', label: m.shop_status_paid() },
				{ value: 'fulfilled', label: m.shop_status_fulfilled() },
				{ value: 'delivered', label: m.shop_status_delivered() },
				{ value: 'refunded', label: m.shop_status_refunded() },
				{ value: 'cancelled', label: m.shop_status_cancelled() }
			]
		}
	];

	function onSort(key: string, dir: SortDirection) {
		const url = new URL(page.url);
		url.searchParams.set('sort', key);
		url.searchParams.set('dir', dir);
		// Current route + new query params — no route ID exists to
		// resolve() (same case as TableToolbar's navigateWith).
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(url, { noScroll: true });
	}

	const columns: Column<Order>[] = [
		{ key: 'order', header: m.shop_admin_col_order(), cell: orderCell },
		{ key: 'email', header: m.shop_admin_col_customer(), cell: emailCell },
		{ key: 'placed', header: m.shop_admin_col_placed(), sortable: true, cell: placedCell },
		{ key: 'status', header: m.cms_filter_status(), cell: statusCell },
		{ key: 'total', header: m.shop_admin_col_total(), align: 'right', numeric: true, sortable: true, cell: totalCell }
	];
</script>

{#snippet orderCell(order: Order)}
	<a
		href={resolve('/(admin)/admin/shop/orders/[id]', { id: order.id })}
		class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{order.orderNumber}
	</a>
{/snippet}

{#snippet emailCell(order: Order)}
	<span class="text-muted-foreground">{order.email}</span>
{/snippet}

{#snippet placedCell(order: Order)}
	<span class="text-xs text-muted-foreground">{new Date(order.createdAt).toLocaleString()}</span>
{/snippet}

{#snippet statusCell(order: Order)}
	<StatusBadge status={order.status} tone={order.status === 'delivered' ? 'success' : undefined} />
{/snippet}

{#snippet totalCell(order: Order)}
	{formatSatang(order.totalSatang as Satang)}
{/snippet}

<PageShell width="wide">
	<PageHeader title={m.shop_admin_orders()} icon={ShoppingCart} />

	<TableToolbar searchPlaceholder={m.shop_search_orders()} {filters} />

	<DataTable
		{columns}
		rows={data.orders}
		getKey={(o) => o.id}
		sortKey={data.sort ?? undefined}
		sortDir={data.dir}
		{onSort}
	>
		{#snippet empty()}
			<p class="text-sm text-muted-foreground">
				{data.search || data.statusFilter ? m.admin_no_results() : m.shop_admin_no_orders()}
			</p>
		{/snippet}
	</DataTable>
</PageShell>
