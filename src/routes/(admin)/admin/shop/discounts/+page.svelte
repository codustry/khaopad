<script lang="ts">
	import { enhance } from '$app/forms';
	import { Ticket, Plus } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let kind = $state<'fixed_satang' | 'percent' | 'free_shipping'>('percent');
	let submitting = $state(false);

	type Code = PageData['codes'][number];

	const columns: Column<Code>[] = [
		{ key: 'code', header: 'Code', cell: codeCell },
		{ key: 'kind', header: 'Kind', cell: kindCell },
		{ key: 'value', header: 'Value', align: 'right', numeric: true, cell: valueCell },
		{ key: 'used', header: 'Used', align: 'right', numeric: true, cell: usedCell },
		{ key: 'status', header: 'Status', cell: statusCell },
		{ key: 'actions', header: '', align: 'right', class: 'w-24', cell: actionsCell }
	];
</script>

{#snippet codeCell(c: Code)}
	<code class="font-mono font-medium">{c.code}</code>
	{#if c.description}
		<div class="mt-0.5 text-xs text-muted-foreground">{c.description}</div>
	{/if}
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
			{c.active ? 'Disable' : 'Enable'}
		</Button>
	</form>
{/snippet}

<PageShell width="wide">
	<PageHeader title="Discount codes" icon={Ticket} />

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
			New code
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
					<Label for="code" class="text-xs">Code (A-Z / 0-9 / _ / -)</Label>
					<Input id="code" name="code" required maxlength={32} placeholder="SAVE10" />
				</div>
				<div class="space-y-1">
					<Label for="kind" class="text-xs">Kind</Label>
					<select
						id="kind"
						name="kind"
						bind:value={kind}
						class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<option value="percent">Percent off</option>
						<option value="fixed_satang">Fixed ฿ off</option>
						<option value="free_shipping" disabled>Free shipping (v3.6+)</option>
					</select>
				</div>
			</div>

			{#if kind === 'percent'}
				<div class="space-y-1">
					<Label for="value_percent" class="text-xs">Percent (0-100)</Label>
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
					<Label for="value_baht" class="text-xs">Amount off (฿)</Label>
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
					<Label for="max_redemptions" class="text-xs">Max redemptions (total)</Label>
					<Input id="max_redemptions" name="max_redemptions" type="number" min="0" />
				</div>
				<div class="space-y-1">
					<Label for="max_per_customer" class="text-xs">Max per customer</Label>
					<Input id="max_per_customer" name="max_per_customer" type="number" min="0" />
				</div>
				<div class="space-y-1">
					<Label for="min_order_baht" class="text-xs">Min order (฿)</Label>
					<Input
						id="min_order_baht"
						name="min_order_baht"
						inputmode="decimal"
						pattern={'[0-9]+(\\.[0-9]{1,2})?'}
					/>
				</div>
			</div>

			<div class="space-y-1">
				<Label for="description" class="text-xs">Description (internal only)</Label>
				<Input id="description" name="description" maxlength={200} />
			</div>

			<div class="flex justify-end">
				<Button type="submit" disabled={submitting}>
					<Plus class="mr-2 h-4 w-4" />
					{submitting ? 'Creating…' : 'Create code'}
				</Button>
			</div>
		</form>
	</section>

	<section>
		<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Existing codes ({data.codes.length})
		</h2>
		<DataTable {columns} rows={data.codes} getKey={(c) => c.id}>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">No codes yet.</p>
			{/snippet}
		</DataTable>
	</section>
	</div>
</PageShell>
