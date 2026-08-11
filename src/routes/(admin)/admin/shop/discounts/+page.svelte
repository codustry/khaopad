<script lang="ts">
	import { enhance } from '$app/forms';
	import { Ticket, Plus } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import * as m from '$lib/paraglide/messages';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let kind = $state<'fixed_satang' | 'percent' | 'free_shipping'>('percent');
	let method = $state<'code' | 'automatic'>('code');
	let submitting = $state(false);

	type Code = PageData['codes'][number];

	const columns: Column<Code>[] = [
		{ key: 'code', header: m.shop_admin_col_code(), cell: codeCell },
		{ key: 'method', header: m.shop_admin_col_method(), cell: methodCell },
		{ key: 'kind', header: m.shop_admin_col_kind(), cell: kindCell },
		{ key: 'value', header: m.shop_admin_col_value(), align: 'right', numeric: true, cell: valueCell },
		{ key: 'used', header: m.shop_admin_col_used(), align: 'right', numeric: true, cell: usedCell },
		{ key: 'status', header: m.cms_filter_status(), cell: statusCell },
		{ key: 'actions', header: '', align: 'right', class: 'w-24', cell: actionsCell }
	];
</script>

{#snippet codeCell(c: Code)}
	{#if c.method === 'automatic'}
		<!-- The AUTO-* sentinel is an implementation detail, not a code
		     anyone can type — show the description (or a dash) instead. -->
		<span class="text-sm">{c.description ?? '—'}</span>
	{:else}
		<code class="font-mono font-medium">{c.code}</code>
		{#if c.description}
			<div class="mt-0.5 text-xs text-muted-foreground">{c.description}</div>
		{/if}
	{/if}
{/snippet}

{#snippet methodCell(c: Code)}
	<span class="text-xs text-muted-foreground">
		{c.method === 'automatic' ? m.shop_admin_method_automatic() : m.shop_admin_method_code()}
	</span>
{/snippet}

{#snippet kindCell(c: Code)}
	<span class="text-xs text-muted-foreground">{c.kind.replace('_', ' ')}</span>
{/snippet}

{#snippet valueCell(c: Code)}
	{#if c.kind === 'percent'}
		{c.valuePercent}%
	{:else if c.kind === 'fixed_satang' && c.valueSatang != null}
		{formatSatang(c.valueSatang as Satang)}
	{:else}
		—
	{/if}
{/snippet}

{#snippet usedCell(c: Code)}
	{c.redemptions}{#if c.maxRedemptions}<span class="text-muted-foreground">
			/ {c.maxRedemptions}</span
		>{/if}
{/snippet}

{#snippet statusCell(c: Code)}
	<StatusBadge status={c.active ? 'active' : 'inactive'} />
{/snippet}

{#snippet actionsCell(c: Code)}
	<form method="POST" action="?/toggle" use:enhance>
		<input type="hidden" name="id" value={c.id} />
		<Button type="submit" variant="ghost" size="sm">
			{c.active ? m.shop_admin_disable() : m.shop_admin_enable()}
		</Button>
	</form>
{/snippet}

<PageShell width="wide">
	<PageHeader title={m.shop_admin_discounts()} icon={Ticket} />

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
			{m.shop_admin_new_code()}
		</h2>
		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: true });
					submitting = false;
				};
			}}
			class="space-y-3"
		>
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1">
					<Label for="method" class="text-xs">{m.shop_admin_method_label()}</Label>
					<select
						id="method"
						name="method"
						bind:value={method}
						class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<option value="code">{m.shop_admin_method_code()}</option>
						<option value="automatic">{m.shop_admin_method_automatic()}</option>
					</select>
					{#if method === 'automatic'}
						<p class="text-xs text-muted-foreground">{m.shop_admin_automatic_hint()}</p>
					{/if}
				</div>
				<div class="space-y-1">
					<Label for="kind" class="text-xs">{m.shop_admin_kind()}</Label>
					<select
						id="kind"
						name="kind"
						bind:value={kind}
						class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<option value="percent">{m.shop_admin_kind_percent()}</option>
						<option value="fixed_satang">{m.shop_admin_kind_fixed()}</option>
						<!-- Enabled since v3.13's server-priced shipping (#158) — the
						     v3.5 "no shipping yet" block is gone. -->
						<option value="free_shipping">{m.shop_admin_kind_free_shipping()}</option>
					</select>
				</div>
			</div>

			{#if method === 'code'}
				<div class="space-y-1">
					<Label for="code" class="text-xs">{m.shop_admin_code_label()}</Label>
					<Input id="code" name="code" required maxlength={32} placeholder="SAVE10" />
				</div>
			{/if}

			{#if kind === 'percent'}
				<div class="space-y-1">
					<Label for="value_percent" class="text-xs">{m.shop_admin_percent_label()}</Label>
					<Input
						id="value_percent"
						name="value_percent"
						type="number"
						min="0.01"
						max="100"
						step="0.01"
						required
					/>
				</div>
			{:else if kind === 'fixed_satang'}
				<div class="space-y-1">
					<Label for="value_baht" class="text-xs">{m.shop_admin_amount_off()}</Label>
					<Input
						id="value_baht"
						name="value_baht"
						inputmode="decimal"
						pattern={'[0-9]+(\\.[0-9]{1,2})?'}
						required
					/>
				</div>
			{/if}

			<div class="grid grid-cols-3 gap-3">
				<div class="space-y-1">
					<Label for="max_redemptions" class="text-xs">{m.shop_admin_max_redemptions()}</Label>
					<Input id="max_redemptions" name="max_redemptions" type="number" min="0" />
				</div>
				<div class="space-y-1">
					<Label for="max_per_customer" class="text-xs">{m.shop_admin_max_per_customer()}</Label>
					<Input id="max_per_customer" name="max_per_customer" type="number" min="0" />
				</div>
				<div class="space-y-1">
					<Label for="min_order_baht" class="text-xs">{m.shop_admin_min_order()}</Label>
					<Input
						id="min_order_baht"
						name="min_order_baht"
						inputmode="decimal"
						pattern={'[0-9]+(\\.[0-9]{1,2})?'}
					/>
				</div>
			</div>

			<div class="space-y-1">
				<Label for="description" class="text-xs">{m.shop_admin_description_internal()}</Label>
				<Input id="description" name="description" maxlength={200} />
			</div>

			<div class="flex justify-end">
				<Button type="submit" disabled={submitting}>
					<Plus class="mr-2 h-4 w-4" />
					{submitting ? m.shop_admin_creating() : m.shop_admin_create_code()}
				</Button>
			</div>
		</form>
	</section>

	<section>
		<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			{m.shop_admin_existing_codes({ count: String(data.codes.length) })}
		</h2>
		<DataTable {columns} rows={data.codes} getKey={(c) => c.id}>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">{m.shop_admin_no_codes()}</p>
			{/snippet}
		</DataTable>
	</section>
	</div>
</PageShell>
