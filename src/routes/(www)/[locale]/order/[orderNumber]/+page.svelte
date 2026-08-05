<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { Package, CheckCircle2, Clock, LoaderCircle } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
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

	// ── Payment recovery (#157) ─────────────────────────────────────
	// The ?payment= query param is a UI HINT ONLY — it never carries
	// authority over payment state. Only the provider webhook writes
	// `paid` (order-service markPaid); the hint merely selects which
	// PENDING presentation to show: `returned` → "confirming" spinner
	// + polling, `failed`/`cancelled`/absent → retry button.
	const paymentHint = $derived(page.url.searchParams.get('payment'));

	const POLL_INTERVAL_MS = 3000;
	const POLL_MAX_MS = 120000; // ~2 min, then fall back to pending + retry

	let confirming = $state(false);
	let pollTimedOut = $state(false);
	let retrying = $state(false);
	let retryError = $state<string | null>(null);

	onMount(() => {
		// Poll ONLY on the ?payment=returned arrival — a plain pending
		// visit gets the retry button immediately, no background traffic.
		if (order.status !== 'pending' || paymentHint !== 'returned') return;
		confirming = true;
		const startedAt = Date.now();
		const timer = setInterval(async () => {
			try {
				// Status-only endpoint — safe to poll unauthenticated.
				const res = await fetch(`/api/shop/order/${order.orderNumber}/status`);
				const body = (await res.json()) as { ok: boolean; status?: string };
				if (body.ok && body.status && body.status !== 'pending') {
					clearInterval(timer);
					confirming = false;
					// Re-run the load — the webhook flipped the order, so the
					// reload renders the paid view (and clears the cart cookie).
					await invalidateAll();
					return;
				}
			} catch {
				/* transient network error — keep polling until the cap */
			}
			if (Date.now() - startedAt > POLL_MAX_MS) {
				clearInterval(timer);
				confirming = false;
				pollTimedOut = true;
			}
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	async function retryPayment() {
		retrying = true;
		retryError = null;
		try {
			// Pay-by-orderNumber (#157): the page never holds the internal
			// order id, only the number in its URL.
			const res = await fetch('/api/shop/checkout/pay', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ orderNumber: order.orderNumber }),
			});
			const body = (await res.json()) as {
				ok: boolean;
				paymentUrl?: string;
				message?: string;
			};
			if (body.ok && body.paymentUrl) {
				window.location.href = body.paymentUrl;
				return;
			}
			retryError = body.message ?? m.shop_err_payment_provider();
		} catch {
			retryError = m.shop_err_network();
		}
		retrying = false;
	}
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

	<div class="mb-6 rounded-lg border border-border bg-muted/50 p-4">
		{#if order.status === 'pending' && confirming}
			<!-- Just back from the payment page — poll until the webhook flips it. -->
			<div class="flex items-center gap-3">
				<LoaderCircle class="h-5 w-5 animate-spin text-amber-600 dark:text-amber-400" />
				<div class="font-medium">{m.shop_confirming_payment()}</div>
			</div>
		{:else}
			<div class="flex items-center gap-3">
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
			{#if order.status === 'pending'}
				<!-- Pending without an active confirmation poll: offer recovery. -->
				<div class="mt-3 space-y-2 border-t border-border pt-3">
					{#if pollTimedOut}
						<p class="text-sm text-muted-foreground">
							{m.shop_payment_not_confirmed_yet()}
						</p>
					{:else if paymentHint === 'failed' || paymentHint === 'cancelled'}
						<p class="text-sm text-muted-foreground">
							{m.shop_payment_failed_try_again()}
						</p>
					{/if}
					<Button onclick={retryPayment} disabled={retrying}>
						{retrying ? m.shop_processing() : m.shop_complete_payment()}
					</Button>
					{#if retryError}
						<div
							class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
						>
							{retryError}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
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
