<script lang="ts">
	import { Package, CheckCircle2, Clock } from 'lucide-svelte';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const order = $derived(data.order);
	const statusLabel = $derived(
		{
			pending: 'Waiting for payment',
			paid: 'Paid — preparing to ship',
			fulfilled: 'Shipped',
			delivered: 'Delivered',
			refunded: 'Refunded',
			cancelled: 'Cancelled',
		}[order.status] ?? order.status,
	);
</script>

<div class="mx-auto max-w-2xl px-6 py-10">
	<header class="mb-6 flex items-center gap-3">
		<Package class="h-6 w-6 text-muted-foreground" />
		<div>
			<h1 class="text-2xl font-semibold">Order {order.orderNumber}</h1>
			<div class="text-sm text-muted-foreground">{order.email}</div>
		</div>
	</header>

	<div class="mb-6 flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-4">
		{#if order.status === 'paid' || order.status === 'fulfilled' || order.status === 'delivered'}
			<CheckCircle2 class="h-5 w-5 text-green-600" />
		{:else if order.status === 'pending'}
			<Clock class="h-5 w-5 text-amber-600" />
		{/if}
		<div>
			<div class="font-medium">{statusLabel}</div>
			{#if order.paidAt}
				<div class="text-xs text-muted-foreground">
					Paid {new Date(order.paidAt).toLocaleString()}
				</div>
			{:else}
				<div class="text-xs text-muted-foreground">
					Placed {new Date(order.createdAt).toLocaleString()}
				</div>
			{/if}
		</div>
	</div>

	<section class="mb-6 space-y-4 rounded-lg border border-border p-4">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Items
		</h2>
		<ul class="divide-y divide-border">
			{#each order.items as item (item.id)}
				<li class="flex gap-4 py-3 text-sm">
					<div class="flex-1 min-w-0">
						<div class="font-medium">{item.titleSnapshot}</div>
						{#if item.skuSnapshot}
							<div class="text-xs text-muted-foreground">
								SKU: {item.skuSnapshot}
							</div>
						{/if}
						<div class="text-xs text-muted-foreground">
							Qty {item.quantity} × {formatSatang(item.priceSnapshotSatang as Satang)}
						</div>
					</div>
					<div class="text-right tabular-nums">
						{formatSatang(item.lineSubtotalSatang as Satang)}
					</div>
				</li>
			{/each}
		</ul>
	</section>

	<section class="mb-6 space-y-1 rounded-lg border border-border p-4 text-sm">
		<div class="flex justify-between text-muted-foreground">
			<span>Subtotal</span>
			<span class="tabular-nums">{formatSatang(order.subtotalSatang as Satang)}</span>
		</div>
		{#if order.shippingSatang > 0}
			<div class="flex justify-between text-muted-foreground">
				<span>Shipping</span>
				<span class="tabular-nums">{formatSatang(order.shippingSatang as Satang)}</span>
			</div>
		{/if}
		{#if order.taxSatang > 0}
			<div class="flex justify-between text-muted-foreground">
				<span>Tax</span>
				<span class="tabular-nums">{formatSatang(order.taxSatang as Satang)}</span>
			</div>
		{/if}
		{#if order.discountSatang > 0}
			<div class="flex justify-between text-muted-foreground">
				<span>Discount</span>
				<span class="tabular-nums">-{formatSatang(order.discountSatang as Satang)}</span>
			</div>
		{/if}
		<div class="flex justify-between border-t border-border pt-2 font-semibold">
			<span>Total</span>
			<span class="tabular-nums">{formatSatang(order.totalSatang as Satang)}</span>
		</div>
	</section>

	{#if data.shippingAddress}
		<section class="rounded-lg border border-border p-4 text-sm">
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Shipping to
			</h2>
			<div class="space-y-1">
				<div>{data.shippingAddress.name}</div>
				<div>{data.shippingAddress.line1}</div>
				{#if data.shippingAddress.line2}
					<div>{data.shippingAddress.line2}</div>
				{/if}
				<div>
					{data.shippingAddress.city}
					{data.shippingAddress.region ?? ''}
					{data.shippingAddress.postalCode}
				</div>
				<div>{data.shippingAddress.countryCode}</div>
			</div>
		</section>
	{/if}
</div>
