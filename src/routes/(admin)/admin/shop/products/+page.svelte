<script lang="ts">
	import { enhance } from '$app/forms';
	import { Package, Plus, Archive, Trash2 } from 'lucide-svelte';
	import { Button, Badge } from '$lib/components/ui';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="max-w-6xl space-y-6 p-6">
	<header class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<Package class="h-6 w-6 text-muted-foreground" />
			<h1 class="text-2xl font-semibold">Products</h1>
		</div>
		<a
			href="/admin/shop/products/new"
			class="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
		>
			<Plus class="h-4 w-4" />
			New product
		</a>
	</header>

	<nav class="flex gap-2 text-sm">
		<a
			href="/admin/shop/products"
			class="rounded px-3 py-1 {!data.statusFilter
				? 'bg-muted font-medium'
				: 'text-muted-foreground hover:text-foreground'}"
		>
			All
		</a>
		{#each ['draft', 'active', 'archived'] as status (status)}
			<a
				href="/admin/shop/products?status={status}"
				class="rounded px-3 py-1 {data.statusFilter === status
					? 'bg-muted font-medium'
					: 'text-muted-foreground hover:text-foreground'}"
			>
				{status[0].toUpperCase() + status.slice(1)}
			</a>
		{/each}
	</nav>

	{#if data.products.length === 0}
		<div class="rounded-lg border border-dashed border-border p-12 text-center">
			<p class="mb-4 text-sm text-muted-foreground">No products yet.</p>
			<a
				href="/admin/shop/products/new"
				class="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
			>
				<Plus class="h-4 w-4" />
				Create your first product
			</a>
		</div>
	{:else}
		<div class="overflow-hidden rounded-lg border border-border">
			<table class="w-full text-sm">
				<thead class="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
					<tr>
						<th class="px-4 py-2">Title</th>
						<th class="px-4 py-2">Slug</th>
						<th class="px-4 py-2">Status</th>
						<th class="px-4 py-2 text-right">Price from</th>
						<th class="px-4 py-2">Stock</th>
						<th class="px-4 py-2 w-32"></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each data.products as product (product.id)}
						<tr>
							<td class="px-4 py-3">
								<a
									href="/admin/shop/products/{product.id}"
									class="font-medium hover:underline"
								>
									{product.title}
								</a>
							</td>
							<td class="px-4 py-3 text-muted-foreground">
								<code class="text-xs">{product.slug}</code>
							</td>
							<td class="px-4 py-3">
								<Badge
									variant={product.status === 'active'
										? 'default'
										: product.status === 'draft'
											? 'secondary'
											: 'outline'}
								>
									{product.status}
								</Badge>
							</td>
							<td class="px-4 py-3 text-right tabular-nums">
								{product.priceFromSatang != null
									? formatSatang(product.priceFromSatang as Satang)
									: '—'}
							</td>
							<td class="px-4 py-3">
								{#if product.inStock}
									<span class="text-xs text-green-600">In stock</span>
								{:else}
									<span class="text-xs text-destructive">Out</span>
								{/if}
							</td>
							<td class="px-4 py-3">
								<div class="flex justify-end gap-1">
									{#if product.status !== 'archived'}
										<form
											method="POST"
											action="?/archive"
											use:enhance
											class="inline"
										>
											<input type="hidden" name="id" value={product.id} />
											<Button
												type="submit"
												variant="ghost"
												size="sm"
												title="Archive"
											>
												<Archive class="h-4 w-4" />
											</Button>
										</form>
									{/if}
									<form
										method="POST"
										action="?/delete"
										use:enhance={() => async ({ update }) => {
											if (
												!confirm(
													`Delete "${product.title}"? This is permanent.`,
												)
											)
												return;
											await update();
										}}
										class="inline"
									>
										<input type="hidden" name="id" value={product.id} />
										<Button
											type="submit"
											variant="ghost"
											size="sm"
											title="Delete"
										>
											<Trash2 class="h-4 w-4 text-destructive" />
										</Button>
									</form>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
