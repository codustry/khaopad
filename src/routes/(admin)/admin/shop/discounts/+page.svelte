<script lang="ts">
	import { enhance } from '$app/forms';
	import { Ticket, Plus } from 'lucide-svelte';
	import { Button, Badge, Input, Label } from '$lib/components/ui';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let kind = $state<'fixed_satang' | 'percent' | 'free_shipping'>('percent');
	let submitting = $state(false);
</script>

<div class="max-w-4xl space-y-6 p-6">
	<header class="flex items-center gap-3">
		<Ticket class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">Discount codes</h1>
	</header>

	{#if form?.error}
		<div class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
			{form.error}
		</div>
	{/if}
	{#if form?.success && form.message}
		<div class="rounded-md border border-green-600/50 bg-green-600/10 p-3 text-sm text-green-700">
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
						class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
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
		{#if data.codes.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center">
				<p class="text-sm text-muted-foreground">No codes yet.</p>
			</div>
		{:else}
			<div class="overflow-hidden rounded-lg border border-border">
				<table class="w-full text-sm">
					<thead class="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
						<tr>
							<th class="px-4 py-2">Code</th>
							<th class="px-4 py-2">Kind</th>
							<th class="px-4 py-2 text-right">Value</th>
							<th class="px-4 py-2 text-right">Used</th>
							<th class="px-4 py-2">Status</th>
							<th class="px-4 py-2 w-24"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each data.codes as c (c.id)}
							<tr>
								<td class="px-4 py-3">
									<code class="font-mono font-medium">{c.code}</code>
									{#if c.description}
										<div class="mt-0.5 text-xs text-muted-foreground">
											{c.description}
										</div>
									{/if}
								</td>
								<td class="px-4 py-3 text-xs text-muted-foreground">
									{c.kind.replace('_', ' ')}
								</td>
								<td class="px-4 py-3 text-right tabular-nums">
									{#if c.kind === 'percent'}
										{c.valuePercent}%
									{:else if c.kind === 'fixed_satang' && c.valueSatang != null}
										{formatSatang(c.valueSatang as Satang)}
									{:else}
										—
									{/if}
								</td>
								<td class="px-4 py-3 text-right tabular-nums">
									{c.redemptions}{#if c.maxRedemptions}
										<span class="text-muted-foreground"> / {c.maxRedemptions}</span>
									{/if}
								</td>
								<td class="px-4 py-3">
									<Badge variant={c.active ? 'default' : 'outline'}>
										{c.active ? 'active' : 'inactive'}
									</Badge>
								</td>
								<td class="px-4 py-3">
									<form method="POST" action="?/toggle" use:enhance>
										<input type="hidden" name="id" value={c.id} />
										<Button type="submit" variant="ghost" size="sm">
											{c.active ? 'Disable' : 'Enable'}
										</Button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
