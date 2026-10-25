<script lang="ts">
	import { page } from '$app/state';
	// Side-effect import: runs slot registrations in the STOREFRONT CLIENT
	// bundle, not just on the server. Without it a registered slot renders
	// during SSR, then hydration finds an empty registry and the fields
	// vanish — and contribute/setValidity are client interactions, so a
	// server-only slot can never actually work. Mirrors the same import in
	// (www)/+layout.svelte; duplicated here so this branch is correct even
	// standalone (modules evaluate once, so the duplication costs nothing).
	import '$lib/plugins/registrations';
	import { CreditCard, ArrowLeft, LoaderCircle } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale } from '$lib/i18n';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import {
		getCheckoutSlots,
		type CheckoutContribution,
	} from '$plugins/shop/checkout-extensions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const locale = $derived(toLocale(page.params.locale ?? 'en'));

	let email = $state(data.cart.email ?? data.userEmail ?? '');
	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);

	// ─── Checkout extension slots (#174 Step 3, #171) ───────────
	// A deployment contributes market-specific fields (a Thai tax invoice,
	// an EU VAT number) without forking this file. Measured against the real
	// fork, that requirement was 75 additive lines in 4 places — so slots
	// cover it, and checkout stays engine-owned. See checkout-extensions.ts.
	// slotProps is declared further down, after the state it reads.
	const slots = $derived(getCheckoutSlots());
	let slotContribution = $state<CheckoutContribution>({});
	let slotError = $state<string | null>(null);

	// Method choice (#156): PromptPay is the default for Thai visitors —
	// it's the dominant local rail — card/hosted for everyone else. The
	// hosted link still offers every method, so this is a soft default,
	// not a gate.
	let method = $state<'promptpay' | 'card'>(
		toLocale(page.params.locale ?? 'en') === 'th' ? 'promptpay' : 'card',
	);

	// Shipping (#158): optional address + a server-quoted method. The
	// client only ever sends a method ID — the server re-quotes and
	// treats an unknown id as a validation failure, so nothing here is
	// trusted with money. Quotes are fetched per country because that is
	// the zone matcher's key.
	let shipToAddress = $state(false);
	// v3.17 D1: prefill from the signed-in customer's saved addresses
	// (default-first — load orders them). Guests get the empty form.
	const savedAddr = data.savedAddresses?.[0] ?? null;
	let addr = $state({
		name: savedAddr?.name ?? '',
		line1: savedAddr?.line1 ?? '',
		line2: savedAddr?.line2 ?? '',
		city: savedAddr?.city ?? '',
		region: savedAddr?.region ?? '',
		postalCode: savedAddr?.postalCode ?? '',
		countryCode:
			savedAddr?.countryCode ?? (toLocale(page.params.locale ?? 'en') === 'th' ? 'TH' : ''),
		phone: savedAddr?.phone ?? '',
	});
	let quotes = $state<Array<{ methodId: string; label: string; amountSatang: number }>>([]);
	let quotesLoading = $state(false);
	let shippingMethod = $state<string | null>(null);

	async function refreshQuotes() {
		const c = addr.countryCode.trim().toUpperCase();
		if (c.length !== 2) {
			quotes = [];
			shippingMethod = null;
			return;
		}
		quotesLoading = true;
		try {
			const res = await fetch(`/api/shop/shipping/quotes?country=${encodeURIComponent(c)}`);
			const body = (await res.json()) as {
				ok: boolean;
				quotes?: Array<{ methodId: string; label: string; amountSatang: number }>;
			};
			quotes = body.ok ? (body.quotes ?? []) : [];
			// Auto-select the first (cheapest-positioned) quote; the visitor
			// can switch. Empty quotes = unserved country or unconfigured
			// store → the server ships at 0, matching checkout/start.
			shippingMethod = quotes[0]?.methodId ?? null;
		} catch {
			quotes = [];
			shippingMethod = null;
		} finally {
			quotesLoading = false;
		}
	}

	const chosenQuote = $derived(quotes.find((q) => q.methodId === shippingMethod) ?? null);
	// Display-only: the server recomputes the authoritative total in
	// checkout/start from its own quote of the same method id.
	const displayTotalSatang = $derived(
		data.totalSatang + (shipToAddress && chosenQuote ? chosenQuote.amountSatang : 0),
	);

	// Everything a slot component receives. Declared here rather than beside
	// the other slot state because it reads shipToAddress and the total,
	// which are defined above — a $derived referencing a later `let` is a
	// TDZ error at module init.
	const slotProps = $derived({
		locale,
		email,
		shipToAddress,
		totalSatang: displayTotalSatang,
		contribute: (c: CheckoutContribution) => {
			slotContribution = c;
		},
		setValidity: (err: string | null) => {
			slotError = err;
		},
	});

	// In-page QR state (#156). Set only when /checkout/pay returns a
	// `qr` payload; while shown we poll the status-only endpoint until
	// the webhook flips the order, then land on the order page.
	let qr = $state<{
		image: string;
		expiresAt?: string;
		orderNumber: string;
		orderId: string;
		/** waiting → scan me; expired/failed → offer a fresh QR (#219). */
		phase: 'waiting' | 'expired' | 'failed';
	} | null>(null);
	let qrPollTimer: ReturnType<typeof setInterval> | null = null;
	let regenerating = $state(false);

	// The order created by the first successful /checkout/start. That call
	// turns the cart into the order, so a retry after a payment failure
	// must reuse it — re-running start hits the now-empty cart (#217).
	let startedOrder = $state<{ id: string; number: string } | null>(null);

	const POLL_INTERVAL_MS = 3000;

	function orderPagePath(orderNumber: string, returned = false) {
		return (
			localePath(locale, `/order/${orderNumber}`) + (returned ? '?payment=returned' : '')
		);
	}

	function startQrPolling(orderNumber: string) {
		if (qrPollTimer) clearInterval(qrPollTimer);
		qrPollTimer = setInterval(async () => {
			try {
				// Status-only endpoint — { ok, status, charge? } and nothing else.
				// While pending it also asks Beam directly (#218), so this
				// moves on even if the webhook never arrives.
				const res = await fetch(`/api/shop/order/${orderNumber}/status`);
				const body = (await res.json()) as {
					ok: boolean;
					status?: string;
					charge?: 'pending' | 'failed';
				};
				if (body.ok && body.status && body.status !== 'pending') {
					if (qrPollTimer) clearInterval(qrPollTimer);
					// Paid (or otherwise resolved) — the order page renders the
					// authoritative state.
					window.location.href = orderPagePath(orderNumber);
					return;
				}
				// Still pending: keep polling even once expired — a payment made
				// in the last seconds can still land — but stop asking the
				// customer to scan a code that no longer works.
				if (qr && qr.phase === 'waiting') {
					if (body.charge === 'failed') qr.phase = 'failed';
					else if (qr.expiresAt && Date.parse(qr.expiresAt) <= Date.now()) {
						qr.phase = 'expired';
					}
				}
			} catch {
				/* transient network error — keep polling */
			}
		}, POLL_INTERVAL_MS);
	}

	$effect(() => {
		return () => {
			if (qrPollTimer) clearInterval(qrPollTimer);
		};
	});

	// The QR ran out, or Beam reported the charge failed: ask for a NEW
	// charge on the same pending order. `attempt` gives it its own
	// idempotency key — reusing the first would get the dead QR back.
	async function regenerateQr() {
		if (!qr || regenerating) return;
		regenerating = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/shop/checkout/pay', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					orderId: qr.orderId,
					method: 'promptpay',
					attempt: crypto.randomUUID().slice(0, 8),
				}),
			});
			const body = (await res.json()) as {
				ok: boolean;
				paymentUrl?: string;
				qr?: { image: string; expiresAt?: string };
				message?: string;
			};
			if (!body.ok) {
				errorMessage = body.message ?? m.shop_err_payment_provider();
				return;
			}
			if (body.qr) {
				qr = { ...qr, image: body.qr.image, expiresAt: body.qr.expiresAt, phase: 'waiting' };
				startQrPolling(qr.orderNumber);
				return;
			}
			// Beam could not issue a QR and fell back to its hosted page.
			if (body.paymentUrl) window.location.href = body.paymentUrl;
		} catch {
			errorMessage = m.shop_err_payment_provider();
		} finally {
			regenerating = false;
		}
	}

	async function pay(event: Event) {
		event.preventDefault();
		if (!email.trim() || !email.includes('@')) {
			errorMessage = m.shop_err_invalid_email();
			return;
		}
		if (shipToAddress) {
			const required = [addr.name, addr.line1, addr.city, addr.postalCode, addr.countryCode];
			if (required.some((f) => !f.trim())) {
				errorMessage = m.shop_addr_incomplete();
				return;
			}
		}
		// A slot may block submission on its OWN fields only — it runs after
		// the engine's checks, so it can never suppress email/address/stock
		// validation. The server re-validates everything regardless.
		if (slotError) {
			errorMessage = slotError;
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
				orderNumber?: string;
				qr?: { image: string; expiresAt?: string };
				message?: string;
			};
			// Step 1: reserve inventory + create pending order — ONCE (#217).
			// After a failed payment the order already exists; go straight to
			// step 2 with a fresh `attempt`, since a charge may have been made.
			const retrying = startedOrder !== null;
			if (!startedOrder) {
				const startRes = await fetch('/api/shop/checkout/start', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						email: email.trim(),
						attributedArticleSlug,
						...(shipToAddress
							? {
									shippingAddress: {
										name: addr.name.trim(),
										line1: addr.line1.trim(),
										line2: addr.line2.trim() || null,
										city: addr.city.trim(),
										region: addr.region.trim() || null,
										postalCode: addr.postalCode.trim(),
										countryCode: addr.countryCode.trim().toUpperCase(),
										phone: addr.phone.trim() || null,
									},
									...(shippingMethod ? { shippingMethod } : {}),
								}
							: {}),
						// Slot contributions (#171). The server validates these the
						// same as any other client input — a slot is a UI
						// contribution, never a trusted source.
						...(slotContribution.billingAddress
							? { billingAddress: slotContribution.billingAddress }
							: {}),
					}),
				});
				const startJson = (await startRes.json()) as StartResponse;
				if (!startJson.ok) {
					errorMessage = startJson.message ?? m.shop_err_checkout_failed();
					submitting = false;
					return;
				}
				startedOrder = { id: startJson.orderId!, number: startJson.orderNumber! };
			}
			const order = startedOrder;
			// Step 2: create Beam charge. PromptPay asks for an in-page QR
			// (#156); the server falls back to the hosted link on ANY QR
			// failure, so a `paymentUrl` response is always possible.
			const payRes = await fetch('/api/shop/checkout/pay', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					orderId: order.id,
					...(method === 'promptpay' ? { method: 'promptpay' } : {}),
					...(retrying ? { attempt: crypto.randomUUID().slice(0, 8) } : {}),
				}),
			});
			const payJson = (await payRes.json()) as PayResponse;
			if (!payJson.ok) {
				errorMessage = payJson.message ?? m.shop_err_payment_provider();
				submitting = false;
				return;
			}
			if (payJson.qr && (payJson.orderNumber ?? order.number)) {
				// In-page QR: render it right here and poll until the webhook
				// flips the order to paid, then land on the order page.
				const orderNumber = (payJson.orderNumber ?? order.number)!;
				qr = { ...payJson.qr, orderNumber, orderId: order.id, phase: 'waiting' };
				submitting = false;
				startQrPolling(orderNumber);
				return;
			}
			if (payJson.paymentUrl) {
				window.location.href = payJson.paymentUrl;
				return;
			}
			// No payment URL — provider returned inline QR or other flow.
			// Fall back to order status page; the customer's next visit
			// will show the pending state.
			window.location.href = localePath(locale, `/order/${order.number}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : m.shop_err_network();
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>{m.shop_checkout_title()}</title>
	<meta name="robots" content="noindex, follow" />
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-10">
	<a
		href={localePath(locale, '/cart')}
		class="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="h-4 w-4" />
		{m.shop_back_to_cart()}
	</a>

	<header class="mb-6 flex items-center gap-3">
		<CreditCard class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">{m.shop_checkout_title()}</h1>
	</header>

	<div class="grid gap-6 md:grid-cols-3">
		<form onsubmit={pay} class="md:col-span-2 space-y-4">
			{#if slots.beforeContact}
				{@const BeforeContact = slots.beforeContact}
				<BeforeContact {...slotProps} />
			{/if}

			<section class="space-y-4 rounded-lg border border-border p-4">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					{m.shop_contact()}
				</h2>
				<div class="space-y-2">
					<Label for="email">{m.shop_email_receipt()}</Label>
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
					{m.shop_shipping()}
				</h2>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						bind:checked={shipToAddress}
						onchange={() => {
							if (shipToAddress) refreshQuotes();
						}}
						disabled={submitting}
						class="h-4 w-4 rounded border-input accent-primary"
					/>
					{m.shop_ship_to_address()}
				</label>

				{#if shipToAddress}
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1 sm:col-span-2">
							<Label for="ship-name">{m.shop_addr_name()}</Label>
							<Input id="ship-name" bind:value={addr.name} disabled={submitting} />
						</div>
						<div class="space-y-1 sm:col-span-2">
							<Label for="ship-line1">{m.shop_addr_line1()}</Label>
							<Input id="ship-line1" bind:value={addr.line1} disabled={submitting} />
						</div>
						<div class="space-y-1 sm:col-span-2">
							<Label for="ship-line2">{m.shop_addr_line2()}</Label>
							<Input id="ship-line2" bind:value={addr.line2} disabled={submitting} />
						</div>
						<div class="space-y-1">
							<Label for="ship-city">{m.shop_addr_city()}</Label>
							<Input id="ship-city" bind:value={addr.city} disabled={submitting} />
						</div>
						<div class="space-y-1">
							<Label for="ship-region">{m.shop_addr_region()}</Label>
							<Input id="ship-region" bind:value={addr.region} disabled={submitting} />
						</div>
						<div class="space-y-1">
							<Label for="ship-postal">{m.shop_addr_postal()}</Label>
							<Input id="ship-postal" bind:value={addr.postalCode} disabled={submitting} />
						</div>
						<div class="space-y-1">
							<Label for="ship-country">{m.shop_addr_country()}</Label>
							<Input
								id="ship-country"
								bind:value={addr.countryCode}
								maxlength={2}
								placeholder="TH"
								onblur={refreshQuotes}
								disabled={submitting}
								class="uppercase"
							/>
						</div>
						<div class="space-y-1">
							<Label for="ship-phone">{m.shop_addr_phone()}</Label>
							<Input id="ship-phone" bind:value={addr.phone} disabled={submitting} />
						</div>
					</div>

					{#if quotesLoading}
						<p class="text-sm text-muted-foreground">{m.shop_processing()}</p>
					{:else if quotes.length > 0}
						<fieldset class="space-y-2" disabled={submitting}>
							<legend class="text-sm font-medium">{m.shop_shipping_method()}</legend>
							{#each quotes as q (q.methodId)}
								<label class="flex items-center justify-between gap-2 text-sm">
									<span class="flex items-center gap-2">
										<input
											type="radio"
											name="shipping-method"
											value={q.methodId}
											bind:group={shippingMethod}
											class="accent-primary"
										/>
										{q.label}
									</span>
									<span class="tabular-nums">{formatSatang(q.amountSatang as Satang)}</span>
								</label>
							{/each}
						</fieldset>
					{:else if addr.countryCode.trim().length === 2}
						<p class="text-sm text-muted-foreground">{m.shop_no_shipping_charge()}</p>
					{/if}
				{/if}
			</section>

			{#if slots.afterAddress}
				{@const AfterAddress = slots.afterAddress}
				<AfterAddress {...slotProps} />
			{/if}

			<section class="space-y-4 rounded-lg border border-border p-4">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					{m.shop_payment()}
				</h2>
				{#if qr}
					<!-- In-page PromptPay QR (#156). Polling runs behind this and
					     moves on by itself once the order is paid; the small link
					     is only a fallback if that never happens. -->
					<div class="flex flex-col items-center gap-3 py-2 text-center">
						{#if qr.phase === 'waiting'}
							<img
								src={qr.image}
								alt={m.shop_qr_alt()}
								class="h-56 w-56 rounded-md border border-border bg-white p-2"
							/>
							<p class="text-sm text-muted-foreground">{m.shop_qr_scan_note()}</p>
							{#if qr.expiresAt}
								<p class="text-xs text-muted-foreground">
									{m.shop_qr_expires({
										datetime: new Date(qr.expiresAt).toLocaleString(),
									})}
								</p>
							{/if}
							<div
								class="flex w-full flex-col items-center gap-1 rounded-md bg-muted px-4 py-3"
								role="status"
								aria-live="polite"
							>
								<span class="flex items-center gap-2 text-sm font-medium">
									<LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
									{m.shop_qr_waiting()}
								</span>
								<span class="text-xs text-muted-foreground">{m.shop_qr_waiting_note()}</span>
							</div>
						{:else}
							<!-- Expired or failed: the old code can no longer be paid, so
							     it is not shown at all — only the way forward. -->
							<div
								class="flex w-full flex-col items-center gap-1 rounded-md border border-border px-4 py-5"
								role="status"
								aria-live="polite"
							>
								<span class="text-sm font-medium">
									{qr.phase === 'expired' ? m.shop_qr_expired() : m.shop_qr_failed()}
								</span>
								<span class="text-xs text-muted-foreground">{m.shop_qr_retry_note()}</span>
							</div>
							<Button onclick={regenerateQr} disabled={regenerating} class="w-full">
								{regenerating ? m.shop_processing() : m.shop_qr_new()}
							</Button>
						{/if}
						<a
							href={orderPagePath(qr.orderNumber, true)}
							class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
						>
							{m.shop_qr_paid_fallback()}
						</a>
					</div>
				{:else}
					<fieldset class="space-y-2" disabled={submitting}>
						<label class="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name="payment-method"
								value="promptpay"
								bind:group={method}
								class="accent-primary"
							/>
							{m.shop_method_promptpay()}
						</label>
						<label class="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name="payment-method"
								value="card"
								bind:group={method}
								class="accent-primary"
							/>
							{m.shop_method_card()}
						</label>
					</fieldset>
					{#if method === 'card'}
						<p class="text-sm text-muted-foreground">
							{m.shop_payment_redirect_note()}
						</p>
					{/if}
				{/if}
			</section>

			{#if slots.beforePayment}
				{@const BeforePayment = slots.beforePayment}
				<BeforePayment {...slotProps} />
			{/if}

			{#if errorMessage}
				<div class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
					{errorMessage}
				</div>
			{/if}

			{#if !qr}
				<Button type="submit" disabled={submitting} class="w-full">
					{submitting
						? m.shop_processing()
						: m.shop_pay_amount({ amount: formatSatang(displayTotalSatang as Satang) })}
				</Button>
			{/if}
		</form>

		<aside class="rounded-lg border border-border p-4 h-fit">
			<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_order_summary()}
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
								{m.shop_qty({ count: item.quantity })}
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
					<span>{m.shop_subtotal()}</span>
					<span class="tabular-nums">
						{formatSatang(data.subtotalSatang as Satang)}
					</span>
				</div>
				<div class="flex justify-between text-muted-foreground">
					<span>{m.shop_shipping()}</span>
					<span class="tabular-nums">
						{#if shipToAddress && chosenQuote}
							{formatSatang(chosenQuote.amountSatang as Satang)}
						{:else if data.shippingSatang > 0}
							{formatSatang(data.shippingSatang as Satang)}
						{:else}
							{m.shop_shipping_calculated_next()}
						{/if}
					</span>
				</div>
				<div class="flex justify-between text-muted-foreground">
					<span>{m.shop_tax()}</span>
					<span class="tabular-nums">
						{data.taxSatang > 0 ? formatSatang(data.taxSatang as Satang) : '—'}
					</span>
				</div>
				<div class="flex justify-between border-t border-border pt-2 font-semibold">
					<span>{m.shop_total()}</span>
					<span class="tabular-nums">
						{formatSatang(displayTotalSatang as Satang)}
					</span>
				</div>
			</div>
		</aside>
	</div>
</div>
