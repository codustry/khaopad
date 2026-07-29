<script lang="ts">
	import { ShoppingCart } from 'lucide-svelte';
	import { Badge } from '$lib/components/ui';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const statuses = ['pending', 'paid', 'fulfilled', 'delivered', 'refunded', 'cancelled'] as const;
</script>

<div class="max-w-6xl space-y-6 p-6">
	<header class="flex items-center gap-3">
		<ShoppingCart class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">Orders</h1>
	</header>

	<nav class="flex flex-wrap gap-2 text-sm">
		<a
			href="/admin/shop/orders"
			class="rounded px-3 py-1 {!data.statusFilter
				? 'bg-muted font-medium'
				: 'text-muted-foreground hover:text-foreground'}"
		>
			All
		</a>
		{#each statuses as status (status)}
			<a
				href="/admin/shop/orders?status={status}"
				class="rounded px-3 py-1 {data.statusFilter === status
					? 'bg-muted font-medium'
					: 'text-muted-foreground hover:text-foreground'}"
			>
				{status[0].toUpperCase() + status.slice(1)}
			</a>
		{/each}
	</nav>

	{#if data.orders.length === 0}
		<div class="rounded-lg border border-dashed border-border p-12 text-center">
			<p class="text-sm text-muted-foreground">No orders yet.</p>
		</div>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border">
			<table class="w-full text-sm">
				<thead class="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
					<tr>
						<th class="px-4 py-2">Order</th>
						<th class="px-4 py-2">Customer</th>
						<th class="px-4 py-2">Placed</th>
						<th class="px-4 py-2">Status</th>
						<th class="px-4 py-2 text-right">Total</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each data.orders as order (order.id)}
						<tr>
							<td class="px-4 py-3">
								<a
									href="/admin/shop/orders/{order.id}"
									class="font-medium hover:underline"
								>
									{order.orderNumber}
								</a>
							</td>
							<td class="px-4 py-3 text-muted-foreground">{order.email}</td>
							<td class="px-4 py-3 text-xs text-muted-foreground">
								{new Date(order.createdAt).toLocaleString()}
							</td>
							<td class="px-4 py-3">
								<Badge
									variant={order.status === 'paid' || order.status === 'delivered'
										? 'default'
										: order.status === 'pending'
											? 'secondary'
											: 'outline'}
								>
									{order.status}
								</Badge>
							</td>
							<td class="px-4 py-3 text-right tabular-nums">
								{formatSatang(order.totalSatang as Satang)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
