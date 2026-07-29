<script lang="ts">
	import { CreditCard, ArrowLeft } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let email = $state(data.cart.email ?? data.userEmail ?? '');
	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);

	async function pay(event: Event) {
		event.preventDefault();
		if (!email.trim() || !email.includes('@')) {
			errorMessage = 'Enter a valid email address';
			return;
		}
		submitting = true;
		errorMessage = null;
		// v3.4 federation: read the article slug the visitor came from
		// (if any) so /checkout/start can tag the pending order and the
		// downstream `purchase` event with attributedArticleId. Stash
		// set by the product page's product_view handler; cleared after
		// use so a second cart doesn't inherit stale attribution.
		let attributedArticleSlug: string | null = null;
		try {
			attributedArticleSlug =
				sessionStorage.getItem('khaopad_shop_attributed_slug') ?? null;
		} catch {
			/* private mode — no stash */
		}

		try {
			type StartResponse = {
				ok: boolean;
				orderId?: string;
				orderNumber?: string;
				message?: string;
			};
			type PayResponse = {
				ok: boolean;
				paymentUrl?: string;
				message?: string;
			};
			// Step 1: reserve inventory + create pending order
			const startRes = await fetch('/api/shop/checkout/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email: email.trim(),
					attributedArticleSlug,
				}),
			});
			const startJson = (await startRes.json()) as StartResponse;
			if (!startJson.ok) {
				errorMessage = startJson.message ?? 'Checkout failed';
				submitting = false;
				return;
			}
			// Step 2: create Beam charge, redirect to payment URL
			const payRes = await fetch('/api/shop/checkout/pay', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ orderId: startJson.orderId }),
			});
			const payJson = (await payRes.json()) as PayResponse;
			if (!payJson.ok) {
				errorMessage = payJson.message ?? 'Payment provider failed';
				submitting = false;
				return;
			}
			if (payJson.paymentUrl) {
				window.location.href = payJson.paymentUrl;
				return;
			}
			// No payment URL — provider returned inline QR or other flow.
			// Fall back to order status page; the customer's next visit
			// will show the pending state.
			window.location.href = `/order/${startJson.orderNumber}`;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Network error';
			submitting = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl px-6 py-10">
	<a
		href="/cart"
		class="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="h-4 w-4" />
		Back to cart
	</a>

	<header class="mb-6 flex items-center gap-3">
		<CreditCard class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">Checkout</h1>
	</header>

	<div class="grid gap-6 md:grid-cols-3">
		<form onsubmit={pay} class="md:col-span-2 space-y-4">
			<section class="space-y-4 rounded-lg border border-border p-4">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					Contact
				</h2>
				<div class="space-y-2">
					<Label for="email">Email (for receipt)</Label>
					<Input
						id="email"
						name="email"
						type="email"
						bind:value={email}
						required
						disabled={submitting}
					/>
				</div>
			</section>

			<section class="space-y-4 rounded-lg border border-border p-4">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					Payment
				</h2>
				<p class="text-sm text-muted-foreground">
					You'll be redirected to Beam to complete payment via PromptPay QR,
					credit card, LINE Pay, or TrueMoney.
				</p>
			</section>

			{#if errorMessage}
				<div class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
					{errorMessage}
				</div>
			{/if}

			<Button type="submit" disabled={submitting} class="w-full">
				{submitting ? 'Processing…' : `Pay ${formatSatang(data.totalSatang as Satang)}`}
			</Button>
		</form>

		<aside class="rounded-lg border border-border p-4 h-fit">
			<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Order summary
			</h2>
			<ul class="mb-4 divide-y divide-border">
				{#each data.items as item (item.id)}
					<li class="flex gap-3 py-2 text-sm">
						<div class="flex-1 min-w-0">
							<div class="font-medium">{item.productTitle}</div>
							{#if item.variantTitle}
								<div class="text-xs text-muted-foreground">
									{item.variantTitle}
								</div>
							{/if}
							<div class="text-xs text-muted-foreground">
								Qty {item.quantity}
							</div>
						</div>
						<div class="text-right tabular-nums">
							{formatSatang((item.priceSatangAtAdd * item.quantity) as Satang)}
						</div>
					</li>
				{/each}
			</ul>
			<div class="space-y-1 border-t border-border pt-3 text-sm">
				<div class="flex justify-between text-muted-foreground">
					<span>Subtotal</span>
					<span class="tabular-nums">
						{formatSatang(data.subtotalSatang as Satang)}
					</span>
				</div>
				<div class="flex justify-between text-muted-foreground">
					<span>Shipping</span>
					<span class="tabular-nums">
						{data.shippingSatang > 0
							? formatSatang(data.shippingSatang as Satang)
							: 'Calculated at next step'}
					</span>
				</div>
				<div class="flex justify-between text-muted-foreground">
					<span>Tax</span>
					<span class="tabular-nums">
						{data.taxSatang > 0 ? formatSatang(data.taxSatang as Satang) : '—'}
					</span>
				</div>
				<div class="flex justify-between border-t border-border pt-2 font-semibold">
					<span>Total</span>
					<span class="tabular-nums">
						{formatSatang(data.totalSatang as Satang)}
					</span>
				</div>
			</div>
		</aside>
	</div>
</div>
