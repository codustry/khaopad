<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Package, RefreshCw } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, StatusBadge } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const order = $derived(data.order);
	const shippingAddress = $derived(
		order.shippingAddressJson ? JSON.parse(order.shippingAddressJson) : null,
	);
</script>

<PageShell>
	<PageHeader
		title={order.orderNumber}
		description="{order.email} · {new Date(order.createdAt).toLocaleString()}"
		icon={Package}
		breadcrumbs={[
			{ label: 'Orders', href: resolve('/(admin)/admin/shop/orders') },
			{ label: order.orderNumber }
		]}
	>
		{#snippet actions()}
			<StatusBadge
				status={order.status}
				tone={order.status === 'delivered' ? 'success' : undefined}
			/>
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
	{#if form?.error}
		<div class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
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
			Items
		</h2>
		<ul class="divide-y divide-border">
			{#each order.items as item (item.id)}
				<li class="flex gap-4 py-3 text-sm">
					<div class="flex-1 min-w-0">
						<div class="font-medium">{item.titleSnapshot}</div>
						{#if item.skuSnapshot}
							<div class="text-xs text-muted-foreground">SKU: {item.skuSnapshot}</div>
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

	<section class="space-y-1 rounded-lg border border-border p-4 text-sm">
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
		<div class="flex justify-between border-t border-border pt-2 font-semibold">
			<span>Total</span>
			<span class="tabular-nums">{formatSatang(order.totalSatang as Satang)}</span>
		</div>
		{#if order.adjustments.length > 0}
			<div class="mt-3 border-t border-border pt-3 space-y-1">
				<div class="text-xs font-semibold uppercase text-muted-foreground">
					Adjustments
				</div>
				{#each order.adjustments as adj (adj.id)}
					<div class="flex justify-between text-xs">
						<span>{adj.kind} {adj.reason ? `— ${adj.reason}` : ''}</span>
						<span class="tabular-nums {adj.amountSatang < 0 ? 'text-destructive' : ''}">
							{formatSatang(adj.amountSatang as Satang)}
						</span>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	{#if shippingAddress}
		<section class="rounded-lg border border-border p-4 text-sm">
			<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Shipping to
			</h2>
			<div class="space-y-1">
				<div>{shippingAddress.name}</div>
				<div>{shippingAddress.line1}</div>
				{#if shippingAddress.line2}
					<div>{shippingAddress.line2}</div>
				{/if}
				<div>
					{shippingAddress.city} {shippingAddress.region ?? ''} {shippingAddress.postalCode}
				</div>
				<div>{shippingAddress.countryCode}</div>
			</div>
		</section>
	{/if}

	<section class="space-y-3 rounded-lg border border-border p-4">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Lifecycle
		</h2>
		<div class="flex flex-wrap gap-2">
			{#if order.status === 'paid'}
				<form method="POST" action="?/fulfil" use:enhance>
					<Button type="submit" size="sm">Mark fulfilled</Button>
				</form>
			{/if}
			{#if order.status === 'fulfilled'}
				<form method="POST" action="?/deliver" use:enhance>
					<Button type="submit" size="sm">Mark delivered</Button>
				</form>
			{/if}
			{#if order.status === 'paid' || order.status === 'fulfilled' || order.status === 'delivered'}
				<details class="w-full">
					<summary class="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
						Issue refund…
					</summary>
					<form
						method="POST"
						action="?/refund"
						use:enhance={() => async ({ update }) => {
							if (!confirm(`Issue refund for ${order.orderNumber}?`)) return;
							await update();
						}}
						class="mt-3 space-y-2 rounded-md border border-input bg-muted/30 p-3"
					>
						<!-- #110: dedupe key minted per render — a double-submit
						     replays the same refund instead of issuing two. -->
						<input type="hidden" name="idempotencyKey" value={data.refundIdempotencyKey} />
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1">
								<Label for="amount" class="text-xs">Amount (฿)</Label>
								<Input
									id="amount"
									name="amount"
									inputmode="decimal"
									pattern={'[0-9]+(\\.[0-9]{1,2})?'}
									placeholder={String(order.totalSatang / 100)}
								/>
							</div>
							<div class="space-y-1">
								<Label for="kind" class="text-xs">Kind</Label>
								<select
									id="kind"
									name="kind"
									class="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
								>
									<option value="refund_partial">Partial</option>
									<option value="refund_full">Full (marks order refunded)</option>
								</select>
							</div>
						</div>
						<div class="space-y-1">
							<Label for="reason" class="text-xs">Reason (optional)</Label>
							<Input id="reason" name="reason" maxlength={200} placeholder="Damaged in transit" />
						</div>
						<div class="flex justify-end">
							<Button type="submit" size="sm" variant="destructive">
								<RefreshCw class="mr-2 h-3.5 w-3.5" />
								Process refund
							</Button>
						</div>
					</form>
				</details>
			{/if}
		</div>
	</section>
	</div>
</PageShell>
