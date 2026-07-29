<script lang="ts">
	import { invalidate, goto } from '$app/navigation';
	import { ShoppingCart, Trash2, ArrowRight } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let busy = $state(false);

	async function updateQty(cartItemId: string, quantity: number) {
		busy = true;
		try {
			await fetch('/api/shop/cart', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cartItemId, quantity }),
			});
			await invalidate('/api/shop/cart');
			location.reload();
		} finally {
			busy = false;
		}
	}

	async function remove(cartItemId: string) {
		busy = true;
		try {
			await fetch('/api/shop/cart', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cartItemId }),
			});
			location.reload();
		} finally {
			busy = false;
		}
	}

	function proceed() {
		goto('/checkout');
	}
</script>

<div class="mx-auto max-w-3xl px-6 py-10">
	<header class="mb-6 flex items-center gap-3">
		<ShoppingCart class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">Your cart</h1>
	</header>

	{#if data.items.length === 0}
		<div class="rounded-lg border border-dashed border-border p-12 text-center">
			<p class="mb-4 text-sm text-muted-foreground">Your cart is empty.</p>
			<a
				href="/en/products/classic-tee"
				class="inline-flex items-center gap-2 text-sm text-primary hover:underline"
			>
				Browse products
				<ArrowRight class="h-4 w-4" />
			</a>
		</div>
	{:else}
		{#if data.priceChanges.length > 0}
			<div class="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
				<p class="font-medium text-amber-900">Prices have changed</p>
				<ul class="mt-2 text-amber-800">
					{#each data.priceChanges as pc (pc.id)}
						<li class="text-xs">
							{pc.productTitle} — was {formatSatang(pc.priceSatangAtAdd as Satang)},
							now {formatSatang(pc.currentPriceSatang as Satang)}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<ul class="divide-y divide-border rounded-lg border border-border">
			{#each data.items as item (item.id)}
				<li class="flex items-center gap-4 p-4">
					<div class="flex-1 min-w-0">
						<div class="font-medium">
							<a
								href="/en/products/{item.productSlug}"
								class="hover:underline"
							>
								{item.productTitle}
							</a>
						</div>
						{#if item.variantTitle}
							<div class="text-xs text-muted-foreground">
								{item.variantTitle}
							</div>
						{/if}
						{#if item.availableStock < item.quantity}
							<div class="mt-1 text-xs text-destructive">
								Only {item.availableStock} in stock
							</div>
						{/if}
					</div>
					<div class="flex items-center gap-2">
						<button
							type="button"
							onclick={() => updateQty(item.id, item.quantity - 1)}
							disabled={busy || item.quantity <= 1}
							class="h-8 w-8 rounded-md border border-input hover:bg-muted disabled:opacity-50"
							aria-label="Decrease quantity"
						>
							−
						</button>
						<span class="w-8 text-center tabular-nums">{item.quantity}</span>
						<button
							type="button"
							onclick={() => updateQty(item.id, item.quantity + 1)}
							disabled={busy || item.quantity >= item.availableStock}
							class="h-8 w-8 rounded-md border border-input hover:bg-muted disabled:opacity-50"
							aria-label="Increase quantity"
						>
							+
						</button>
					</div>
					<div class="w-24 text-right tabular-nums">
						{formatSatang((item.priceSatangAtAdd * item.quantity) as Satang)}
					</div>
					<button
						type="button"
						onclick={() => remove(item.id)}
						disabled={busy}
						class="text-muted-foreground hover:text-destructive"
						aria-label="Remove item"
					>
						<Trash2 class="h-4 w-4" />
					</button>
				</li>
			{/each}
		</ul>

		<div class="mt-6 flex items-center justify-between border-t border-border pt-4">
			<div class="text-sm text-muted-foreground">
				Subtotal ({data.itemCount} item{data.itemCount === 1 ? '' : 's'})
			</div>
			<div class="text-xl font-semibold tabular-nums">
				{formatSatang(data.subtotalSatang as Satang)}
			</div>
		</div>

		<div class="mt-6 flex justify-end">
			<Button onclick={proceed} disabled={busy}>
				Proceed to checkout
				<ArrowRight class="ml-2 h-4 w-4" />
			</Button>
		</div>
	{/if}
</div>
