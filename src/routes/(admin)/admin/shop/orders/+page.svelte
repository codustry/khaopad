<script lang="ts">
	import { resolve } from '$app/paths';
	import { ShoppingCart } from 'lucide-svelte';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Order = PageData['orders'][number];

	const statuses = ['pending', 'paid', 'fulfilled', 'delivered', 'refunded', 'cancelled'] as const;

	const columns: Column<Order>[] = [
		{ key: 'order', header: 'Order', cell: orderCell },
		{ key: 'email', header: 'Customer', cell: emailCell },
		{ key: 'placed', header: 'Placed', cell: placedCell },
		{ key: 'status', header: 'Status', cell: statusCell },
		{ key: 'total', header: 'Total', align: 'right', numeric: true, cell: totalCell }
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
	<PageHeader title="Orders" icon={ShoppingCart} />

	<nav class="mb-6 flex flex-wrap gap-2 text-sm">
		<a
			href={resolve('/(admin)/admin/shop/orders')}
			class="rounded px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {!data.statusFilter
				? 'bg-muted font-medium'
				: 'text-muted-foreground hover:text-foreground'}"
		>
			All
		</a>
		{#each statuses as status (status)}
			<a
				href={resolve(`/(admin)/admin/shop/orders?status=${status}`)}
				class="rounded px-3 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {data.statusFilter ===
				status
					? 'bg-muted font-medium'
					: 'text-muted-foreground hover:text-foreground'}"
			>
				{status[0].toUpperCase() + status.slice(1)}
			</a>
		{/each}
	</nav>

	<DataTable {columns} rows={data.orders} getKey={(o) => o.id}>
		{#snippet empty()}
			<p class="text-sm text-muted-foreground">No orders yet.</p>
		{/snippet}
	</DataTable>
</PageShell>
