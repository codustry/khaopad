<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Package, RefreshCw, Truck, Undo2 } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, StatusBadge } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import { CARRIERS, carrierLabel, trackingUrl } from '$plugins/shop/carriers';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const order = $derived(data.order);
	const shippingAddress = $derived(
		order.shippingAddressJson ? JSON.parse(order.shippingAddressJson) : null,
	);
	const fulfillment = $derived(data.fulfillment);
	const fulfillmentTrackingUrl = $derived(
		fulfillment ? trackingUrl(fulfillment.carrier, fulfillment.trackingNumber) : null,
	);
	// C2 timeline labels — admin stays English this phase (C6 owns the
	// Thai sweep).
	const EVENT_LABELS: Record<string, string> = {
		created: 'Created',
		paid: 'Paid',
		fulfilled: 'Fulfilled',
		delivered: 'Delivered',
		cancelled: 'Cancelled',
		refund: 'Refund',
		note: 'Note',
		return_requested: 'Return requested',
		return_approved: 'Return approved',
		return_received: 'Return received',
		return_refunded: 'Return refunded',
		return_rejected: 'Return rejected',
	};
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
		{#if fulfillment}
			<!-- C1: recorded shipment -->
			<div class="flex items-center gap-2 rounded-md border border-input bg-muted/30 p-3 text-sm">
				<Truck class="h-4 w-4 text-muted-foreground" />
				<span>
					{fulfillment.carrier ? carrierLabel(fulfillment.carrier) : 'Shipped'}
					{#if fulfillment.trackingNumber}
						·
						{#if fulfillmentTrackingUrl}
							<!-- External carrier tracking URL, not an app route. -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={fulfillmentTrackingUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="underline underline-offset-2 tabular-nums"
							>
								{fulfillment.trackingNumber}
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{:else}
							<span class="tabular-nums">{fulfillment.trackingNumber}</span>
						{/if}
					{/if}
					{#if fulfillment.notifiedAt}
						<span class="text-xs text-muted-foreground">· customer notified</span>
					{/if}
				</span>
			</div>
		{/if}
		<div class="flex flex-wrap gap-2">
			{#if order.status === 'paid'}
				<!-- C1: fulfil with carrier + tracking. Both optional. -->
				<form
					method="POST"
					action="?/fulfil"
					use:enhance
					class="w-full space-y-2 rounded-md border border-input bg-muted/30 p-3"
				>
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1">
							<Label for="carrier" class="text-xs">Carrier</Label>
							<select
								id="carrier"
								name="carrier"
								class="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
							>
								<option value="">— none —</option>
								{#each CARRIERS as carrier (carrier.id)}
									<option value={carrier.id}>{carrier.label}</option>
								{/each}
							</select>
						</div>
						<div class="space-y-1">
							<Label for="trackingNumber" class="text-xs">Tracking number</Label>
							<Input
								id="trackingNumber"
								name="trackingNumber"
								maxlength={64}
								placeholder="EX123456789TH"
								class="tabular-nums"
							/>
						</div>
					</div>
					<div class="flex justify-end">
						<Button type="submit" size="sm">
							<Truck class="mr-2 h-3.5 w-3.5" />
							Mark fulfilled
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">
						Sends the customer a shipped email with the tracking link (when email is configured).
					</p>
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

	{#if data.returns.length > 0}
		<!-- C10: returns queue for this order -->
		<section class="space-y-3 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Returns
			</h2>
			<ul class="space-y-3">
				{#each data.returns as ret (ret.id)}
					<li class="space-y-2 rounded-md border border-input bg-muted/30 p-3 text-sm">
						<div class="flex items-center justify-between gap-2">
							<div class="flex items-center gap-2">
								<Undo2 class="h-4 w-4 text-muted-foreground" />
								<StatusBadge status={ret.state} />
							</div>
							<span class="text-xs text-muted-foreground">
								{new Date(ret.createdAt).toLocaleString()}
							</span>
						</div>
						{#if ret.reasonText}
							<p class="text-muted-foreground">“{ret.reasonText}”</p>
						{/if}
						{#if ret.state === 'requested' || ret.state === 'approved' || ret.state === 'received'}
							<div class="flex flex-wrap items-center gap-2 pt-1">
								{#if ret.state === 'requested'}
									<form method="POST" action="?/returnTransition" use:enhance>
										<input type="hidden" name="returnId" value={ret.id} />
										<input type="hidden" name="to" value="approved" />
										<Button type="submit" size="sm">Approve</Button>
									</form>
								{/if}
								{#if ret.state === 'approved'}
									<form method="POST" action="?/returnTransition" use:enhance>
										<input type="hidden" name="returnId" value={ret.id} />
										<input type="hidden" name="to" value="received" />
										<Button type="submit" size="sm">Mark received</Button>
									</form>
								{/if}
								{#if ret.state === 'requested' || ret.state === 'approved'}
									<form method="POST" action="?/returnTransition" use:enhance>
										<input type="hidden" name="returnId" value={ret.id} />
										<input type="hidden" name="to" value="rejected" />
										<Button type="submit" size="sm" variant="outline">Reject</Button>
									</form>
								{/if}
								{#if ret.state === 'received'}
									<p class="text-xs text-muted-foreground">
										Issue the refund via “Issue refund…” above — the return flips to
										refunded automatically.
									</p>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- C2: timeline + staff notes, newest first -->
	<section class="space-y-3 rounded-lg border border-border p-4">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Timeline
		</h2>
		<form
			method="POST"
			action="?/addNote"
			use:enhance
			class="flex items-start gap-2"
		>
			<Input name="message" maxlength={500} placeholder="Add a note…" class="flex-1" />
			<Button type="submit" size="sm" variant="outline">Add note</Button>
		</form>
		{#if data.events.length === 0}
			<p class="text-sm text-muted-foreground">No events yet.</p>
		{:else}
			<ol class="space-y-3">
				{#each data.events as event (event.id)}
					<li class="flex gap-3 text-sm">
						<div class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-border"></div>
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-baseline gap-x-2">
								<span class="font-medium">{EVENT_LABELS[event.kind] ?? event.kind}</span>
								<span class="text-xs text-muted-foreground">
									{new Date(event.createdAt).toLocaleString()}
									{#if event.actorEmail}
										· {event.actorEmail}
									{/if}
								</span>
							</div>
							{#if event.message}
								<p class="text-muted-foreground">{event.message}</p>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</section>
	</div>
</PageShell>
