<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { Button, Input, Label } from '$lib/components/ui';
	import * as m from '$lib/paraglide/messages';
	import { localePath } from '$lib/i18n';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data, form }: { data: PageData; form: { error?: string } | null } = $props();

	// ─── OTP sign-in (two steps) ───────────────────────────
	let email = $state('');
	let otp = $state('');
	let step = $state<'email' | 'code'>('email');
	let busy = $state(false);
	let authError = $state<string | null>(null);

	async function sendCode(event: Event) {
		event.preventDefault();
		if (!email.trim() || !email.includes('@')) {
			authError = m.shop_err_invalid_email();
			return;
		}
		busy = true;
		authError = null;
		try {
			const res = await fetch('/api/auth/email-otp/send-verification-otp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: email.trim(), type: 'sign-in' })
			});
			if (!res.ok) {
				authError = m.account_err_send_code();
				return;
			}
			step = 'code';
		} catch {
			authError = m.account_err_send_code();
		} finally {
			busy = false;
		}
	}

	async function verifyCode(event: Event) {
		event.preventDefault();
		if (!otp.trim()) return;
		busy = true;
		authError = null;
		try {
			const res = await fetch('/api/auth/sign-in/email-otp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: email.trim(), otp: otp.trim() })
			});
			if (!res.ok) {
				authError = m.account_err_verify();
				return;
			}
			await invalidateAll();
		} catch {
			authError = m.account_err_verify();
		} finally {
			busy = false;
		}
	}

	async function signOut() {
		busy = true;
		try {
			await fetch('/api/auth/sign-out', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	// ─── Address form state ────────────────────────────────
	let showAddForm = $state(false);
	let editingId = $state<string | null>(null);

	const dateFmt = $derived(
		new Intl.DateTimeFormat(data.locale === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'medium' })
	);
</script>

<svelte:head>
	<title>{m.account_head_title()}</title>
	<!-- Personal page: order history + addresses. Never in a SERP. -->
	<meta name="robots" content="noindex, follow" />
</svelte:head>

<div class="mx-auto max-w-2xl px-6 py-10">
	<h1 class="mb-8 text-2xl font-semibold tracking-tight">{m.account_title()}</h1>

	{#if !data.account}
		<!-- ─── Signed out: OTP login ──────────────────────── -->
		<section class="rounded-lg border border-border p-6">
			<h2 class="mb-1 text-lg font-medium">{m.account_signin_title()}</h2>
			<p class="mb-4 text-sm text-muted-foreground">{m.account_signin_hint()}</p>

			{#if step === 'email'}
				<form onsubmit={sendCode} class="space-y-3">
					<div class="space-y-1.5">
						<Label for="account-email">{m.account_email_label()}</Label>
						<Input
							id="account-email"
							type="email"
							bind:value={email}
							autocomplete="email"
							required
						/>
					</div>
					<Button type="submit" disabled={busy}>{m.account_send_code()}</Button>
				</form>
			{:else}
				<form onsubmit={verifyCode} class="space-y-3">
					<p class="text-sm text-muted-foreground">{m.account_code_sent({ email })}</p>
					<div class="space-y-1.5">
						<Label for="account-otp">{m.account_code_label()}</Label>
						<Input
							id="account-otp"
							type="text"
							inputmode="numeric"
							autocomplete="one-time-code"
							bind:value={otp}
							required
						/>
					</div>
					<div class="flex items-center gap-3">
						<Button type="submit" disabled={busy}>{m.account_verify()}</Button>
						<button
							type="button"
							class="text-sm text-muted-foreground underline"
							onclick={() => {
								step = 'email';
								otp = '';
								authError = null;
							}}
						>
							{m.account_use_other_email()}
						</button>
					</div>
				</form>
			{/if}
			{#if authError}
				<p class="mt-3 text-sm text-destructive">{authError}</p>
			{/if}
		</section>
	{:else}
		<!-- ─── Signed in ──────────────────────────────────── -->
		<div class="mb-8 flex items-center justify-between gap-3">
			<p class="text-sm text-muted-foreground">
				{m.account_signed_in_as({ email: data.account.email })}
			</p>
			<button type="button" class="text-sm underline" onclick={signOut} disabled={busy}>
				{m.account_sign_out()}
			</button>
		</div>

		{#if form?.error}
			<p class="mb-4 text-sm text-destructive">{form.error}</p>
		{/if}

		<!-- Order history -->
		<section class="mb-10">
			<h2 class="mb-3 text-lg font-medium">{m.account_orders_title()}</h2>
			{#if data.account.orders.length === 0}
				<p class="text-sm text-muted-foreground">{m.account_orders_empty()}</p>
			{:else}
				<ul class="divide-y divide-border rounded-lg border border-border">
					{#each data.account.orders as order (order.orderNumber)}
						<li class="flex items-center justify-between gap-3 p-4">
							<div>
								<div class="text-sm font-medium tabular-nums">{order.orderNumber}</div>
								<div class="text-xs text-muted-foreground">
									{dateFmt.format(new Date(order.createdAt))} · {order.status}
								</div>
							</div>
							<div class="flex items-center gap-4">
								<span class="text-sm font-medium tabular-nums">
									{formatSatang(order.totalSatang as Satang, data.locale === 'th' ? 'th' : 'en')}
								</span>
								<a
									href={localePath(data.locale, `/order/${order.orderNumber}`) +
										`?email=${encodeURIComponent(data.account.email)}`}
									class="text-sm underline"
								>
									{m.account_order_view()}
								</a>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Saved addresses -->
		<section>
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-lg font-medium">{m.account_addresses_title()}</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onclick={() => {
						showAddForm = !showAddForm;
						editingId = null;
					}}
				>
					{m.account_address_add()}
				</Button>
			</div>

			{#if data.account.addresses.length === 0 && !showAddForm}
				<p class="text-sm text-muted-foreground">{m.account_addresses_empty()}</p>
			{/if}

			<ul class="space-y-3">
				{#each data.account.addresses as addr (addr.id)}
					<li class="rounded-lg border border-border p-4">
						{#if editingId === addr.id}
							<form
								method="POST"
								action="?/updateAddress"
								use:enhance={() =>
									async ({ update }) => {
										editingId = null;
										await update();
									}}
								class="grid gap-3 sm:grid-cols-2"
							>
								<input type="hidden" name="addressId" value={addr.id} />
								{@render addressFields(addr)}
								<div class="flex gap-2 sm:col-span-2">
									<Button type="submit" size="sm">{m.account_address_save()}</Button>
								</div>
							</form>
						{:else}
							<div class="flex items-start justify-between gap-3">
								<div class="text-sm">
									<div class="font-medium">
										{addr.name}
										{#if addr.isDefault}
											<span
												class="ml-2 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
											>
												{m.account_address_default()}
											</span>
										{/if}
									</div>
									<div class="text-muted-foreground">
										{addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}, {addr.city}
										{addr.region ? `, ${addr.region}` : ''}
										{addr.postalCode} · {addr.countryCode}
									</div>
									{#if addr.phone}
										<div class="text-muted-foreground">{addr.phone}</div>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-3">
									{#if !addr.isDefault}
										<form method="POST" action="?/updateAddress" use:enhance>
											<input type="hidden" name="addressId" value={addr.id} />
											<input type="hidden" name="name" value={addr.name} />
											<input type="hidden" name="line1" value={addr.line1} />
											<input type="hidden" name="line2" value={addr.line2 ?? ''} />
											<input type="hidden" name="city" value={addr.city} />
											<input type="hidden" name="region" value={addr.region ?? ''} />
											<input type="hidden" name="postalCode" value={addr.postalCode} />
											<input type="hidden" name="countryCode" value={addr.countryCode} />
											<input type="hidden" name="phone" value={addr.phone ?? ''} />
											<input type="hidden" name="isDefault" value="true" />
											<button type="submit" class="text-xs underline">
												{m.account_address_make_default()}
											</button>
										</form>
									{/if}
									<button
										type="button"
										class="text-xs underline"
										onclick={() => {
											editingId = editingId === addr.id ? null : addr.id;
											showAddForm = false;
										}}
									>
										{m.account_address_edit()}
									</button>
									<form method="POST" action="?/deleteAddress" use:enhance>
										<input type="hidden" name="addressId" value={addr.id} />
										<button type="submit" class="text-xs text-destructive underline">
											{m.account_address_delete()}
										</button>
									</form>
								</div>
							</div>
						{/if}
					</li>
				{/each}
			</ul>

			{#if showAddForm}
				<form
					method="POST"
					action="?/addAddress"
					use:enhance={() =>
						async ({ update }) => {
							showAddForm = false;
							await update();
						}}
					class="mt-4 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2"
				>
					{@render addressFields(null)}
					<div class="flex gap-2 sm:col-span-2">
						<Button type="submit" size="sm">{m.account_address_save()}</Button>
					</div>
				</form>
			{/if}
		</section>
	{/if}
</div>

{#snippet addressFields(addr: {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	countryCode: string;
	phone: string | null;
	isDefault: boolean;
} | null)}
	<div class="space-y-1.5">
		<Label for="addr-name">{m.shop_addr_name()}</Label>
		<Input id="addr-name" name="name" value={addr?.name ?? ''} required />
	</div>
	<div class="space-y-1.5">
		<Label for="addr-line1">{m.shop_addr_line1()}</Label>
		<Input id="addr-line1" name="line1" value={addr?.line1 ?? ''} required />
	</div>
	<div class="space-y-1.5">
		<Label for="addr-line2">{m.shop_addr_line2()}</Label>
		<Input id="addr-line2" name="line2" value={addr?.line2 ?? ''} />
	</div>
	<div class="space-y-1.5">
		<Label for="addr-city">{m.shop_addr_city()}</Label>
		<Input id="addr-city" name="city" value={addr?.city ?? ''} required />
	</div>
	<div class="space-y-1.5">
		<Label for="addr-region">{m.shop_addr_region()}</Label>
		<Input id="addr-region" name="region" value={addr?.region ?? ''} />
	</div>
	<div class="space-y-1.5">
		<Label for="addr-postal">{m.shop_addr_postal()}</Label>
		<Input id="addr-postal" name="postalCode" value={addr?.postalCode ?? ''} required />
	</div>
	<div class="space-y-1.5">
		<Label for="addr-country">{m.shop_addr_country()}</Label>
		<Input
			id="addr-country"
			name="countryCode"
			value={addr?.countryCode ?? (data.locale === 'th' ? 'TH' : '')}
			maxlength={2}
			required
		/>
	</div>
	<div class="space-y-1.5">
		<Label for="addr-phone">{m.shop_addr_phone()}</Label>
		<Input id="addr-phone" name="phone" value={addr?.phone ?? ''} />
	</div>
	<label class="flex items-center gap-2 text-sm sm:col-span-2">
		<input type="checkbox" name="isDefault" checked={addr?.isDefault ?? false} />
		{m.account_address_make_default()}
	</label>
{/snippet}
