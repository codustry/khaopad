<script lang="ts">
	import { Package, CheckCircle2, Clock } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const order = $derived(data.order);
	const statusLabel = $derived(
		{
			pending: m.shop_status_pending(),
			paid: m.shop_status_paid(),
			fulfilled: m.shop_status_fulfilled(),
			delivered: m.shop_status_delivered(),
			refunded: m.shop_status_refunded(),
			cancelled: m.shop_status_cancelled(),
		}[order.status] ?? order.status,
	);
</script>

<svelte:head>
	<title>{m.shop_order_title({ number: order.orderNumber })}</title>
	<!-- Order URLs contain order numbers and reveal purchase details to
	     anyone holding the link — the last thing that belongs in an index
	     (#144). -->
	<meta name="robots" content="noindex, follow" />
</svelte:head>

<div class="mx-auto max-w-2xl px-6 py-10">
	<header class="mb-6 flex items-center gap-3">
		<Package class="h-6 w-6 text-muted-foreground" />
		<div>
			<h1 class="text-2xl font-semibold">
				{m.shop_order_title({ number: order.orderNumber })}
			</h1>
			<div class="text-sm text-muted-foreground">{order.email}</div>
		</div>
	</header>

	<div class="mb-6 flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-4">
		{#if order.status === 'paid' || order.status === 'fulfilled' || order.status === 'delivered'}
			<CheckCircle2 class="h-5 w-5 text-green-600 dark:text-green-400" />
		{:else if order.status === 'pending'}
			<Clock class="h-5 w-5 text-amber-600 dark:text-amber-400" />
		{/if}
		<div>
			<div class="font-medium">{statusLabel}</div>
			{#if order.paidAt}
				<div class="text-xs text-muted-foreground">
					{m.shop_paid_at({ datetime: new Date(order.paidAt).toLocaleString() })}
				</div>
			{:else}
				<div class="text-xs text-muted-foreground">
					{m.shop_placed_at({ datetime: new Date(order.createdAt).toLocaleString() })}
				</div>
			{/if}
		</div>
	</div>

	<section class="mb-6 space-y-4 rounded-lg border border-border p-4">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			{m.shop_items()}
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
							{m.shop_qty_x_price({
								count: item.quantity,
								price: formatSatang(item.priceSnapshotSatang as Satang),
							})}
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
			<span>{m.shop_subtotal()}</span>
			<span class="tabular-nums">{formatSatang(order.subtotalSatang as Satang)}</span>
		</div>
		{#if order.shippingSatang > 0}
			<div class="flex justify-between text-muted-foreground">
				<span>{m.shop_shipping()}</span>
				<span class="tabular-nums">{formatSatang(order.shippingSatang as Satang)}</span>
			</div>
		{/if}
		{#if order.taxSatang > 0}
			<div class="flex justify-between text-muted-foreground">
				<span>{m.shop_tax()}</span>
				<span class="tabular-nums">{formatSatang(order.taxSatang as Satang)}</span>
			</div>
		{/if}
		{#if order.discountSatang > 0}
			<div class="flex justify-between text-muted-foreground">
				<span>{m.shop_discount()}</span>
				<span class="tabular-nums">-{formatSatang(order.discountSatang as Satang)}</span>
			</div>
		{/if}
		<div class="flex justify-between border-t border-border pt-2 font-semibold">
			<span>{m.shop_total()}</span>
			<span class="tabular-nums">{formatSatang(order.totalSatang as Satang)}</span>
		</div>
	</section>

	{#if data.shippingAddress}
		<section class="rounded-lg border border-border p-4 text-sm">
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_shipping_to()}
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
