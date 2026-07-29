<script lang="ts">
	import { enhance } from '$app/forms';
	import { Package, ArrowLeft, Trash2 } from 'lucide-svelte';
	import { Button, Badge, Input, Label } from '$lib/components/ui';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const product = $derived(data.product);
	const enTitle = $derived(product.localizations['en']?.title ?? product.slug);
</script>

<div class="max-w-4xl space-y-6 p-6">
	<a
		href="/admin/shop/products"
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="h-4 w-4" />
		Back to products
	</a>

	<header class="flex items-start justify-between gap-4">
		<div class="flex items-start gap-3">
			<Package class="mt-1 h-6 w-6 text-muted-foreground" />
			<div>
				<h1 class="text-2xl font-semibold">{enTitle}</h1>
				<code class="text-xs text-muted-foreground">{product.slug}</code>
			</div>
		</div>
		<Badge
			variant={product.status === 'active'
				? 'default'
				: product.status === 'draft'
					? 'secondary'
					: 'outline'}
		>
			{product.status}
		</Badge>
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
			Localizations
		</h2>
		<div class="space-y-3">
			{#each Object.entries(product.localizations) as [locale, loc] (locale)}
				<div>
					<div class="mb-1 flex items-center gap-2">
						<Badge variant="outline">{locale}</Badge>
						<span class="font-medium">{loc.title}</span>
					</div>
					{#if loc.descriptionMarkdown}
						<div class="ml-14 text-sm text-muted-foreground line-clamp-3">
							{loc.descriptionMarkdown}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</section>

	<section class="space-y-4 rounded-lg border border-border p-4">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Variants ({product.variants.length})
		</h2>
		{#if product.variants.length === 0}
			<p class="text-sm text-muted-foreground">No variants.</p>
		{:else}
			<table class="w-full text-sm">
				<thead class="text-left text-xs uppercase text-muted-foreground">
					<tr>
						<th class="py-2">Title</th>
						<th class="py-2">SKU</th>
						<th class="py-2 text-right">Price</th>
						<th class="py-2 text-right">On hand</th>
						<th class="py-2 text-right">Reserved</th>
						<th class="py-2 text-right">Available</th>
						<th class="py-2 w-40">Adjust inventory</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each product.variants as variant (variant.id)}
						<tr>
							<td class="py-2 font-medium">
								{variant.titleCached || 'Default'}
								{#if variant.status === 'archived'}
									<Badge variant="outline" class="ml-2">archived</Badge>
								{/if}
							</td>
							<td class="py-2 text-muted-foreground">
								<code class="text-xs">{variant.sku ?? '—'}</code>
							</td>
							<td class="py-2 text-right tabular-nums">
								{formatSatang(variant.priceSatang as Satang)}
							</td>
							<td class="py-2 text-right tabular-nums">
								{variant.inventory?.onHand ?? '—'}
							</td>
							<td class="py-2 text-right tabular-nums">
								{variant.inventory?.reserved ?? '—'}
							</td>
							<td class="py-2 text-right tabular-nums">
								{#if variant.inventory}
									<span
										class={variant.inventory.available > 0
											? 'text-green-700'
											: 'text-destructive'}
									>
										{variant.inventory.available}
									</span>
								{:else}
									—
								{/if}
							</td>
							<td class="py-2">
								<form
									method="POST"
									action="?/adjustInventory"
									use:enhance
									class="flex gap-1"
								>
									<input type="hidden" name="variantId" value={variant.id} />
									<Input
										type="number"
										name="delta"
										placeholder="±N"
										class="h-8 w-20 text-xs"
									/>
									<Button type="submit" size="sm" variant="outline">Apply</Button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="space-y-4 rounded-lg border border-border p-4">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Status
		</h2>
		<form
			method="POST"
			action="?/setStatus"
			use:enhance
			class="flex items-center gap-3"
		>
			<Label for="status" class="sr-only">Status</Label>
			<select
				id="status"
				name="status"
				value={product.status}
				class="rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
			>
				<option value="draft">Draft (invisible to public)</option>
				<option value="active">Active (published)</option>
				<option value="archived">Archived (hidden, admin+ only)</option>
			</select>
			<Button type="submit" size="sm">Update</Button>
		</form>
	</section>

	<section class="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
		<h2 class="text-sm font-semibold uppercase tracking-wider text-destructive">
			Danger zone
		</h2>
		<div class="flex items-start justify-between gap-4">
			<div>
				<p class="text-sm font-medium">Delete this product</p>
				<p class="text-xs text-muted-foreground">
					Cascades to variants, options, and inventory. Cart/order rows
					referencing this product will show as "Product no longer available"
					after v3.2 lands.
				</p>
			</div>
			<form
				method="POST"
				action="?/delete"
				use:enhance={() => async ({ update }) => {
					if (!confirm(`Delete "${enTitle}"? This cannot be undone.`)) return;
					await update();
				}}
			>
				<Button type="submit" variant="destructive" size="sm">
					<Trash2 class="mr-2 h-4 w-4" />
					Delete
				</Button>
			</form>
		</div>
	</section>
</div>
