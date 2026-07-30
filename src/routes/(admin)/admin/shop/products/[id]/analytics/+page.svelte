<script lang="ts">
	import { resolve } from '$app/paths';
	import { ArrowLeft, BarChart3 } from 'lucide-svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const a = $derived(data.analytics);
	function pct(x: number): string {
		return `${Math.round(x * 1000) / 10}%`;
	}
</script>

<div class="max-w-4xl space-y-6 p-6">
	<a
		href={resolve('/(admin)/admin/shop/products/[id]', { id: data.productId })}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="h-4 w-4" />
		Back to product
	</a>

	<header class="flex items-center gap-3">
		<BarChart3 class="h-6 w-6 text-muted-foreground" />
		<div>
			<h1 class="text-2xl font-semibold">Analytics</h1>
			<div class="text-sm text-muted-foreground">
				{data.productTitle} · past {a.windowDays} days
			</div>
		</div>
	</header>

	<div class="grid gap-4 sm:grid-cols-3">
		<div class="rounded-lg border border-border p-4">
			<div class="text-xs uppercase tracking-wider text-muted-foreground">Views</div>
			<div class="mt-1 text-3xl font-semibold tabular-nums">
				{a.productViews.toLocaleString()}
			</div>
		</div>
		<div class="rounded-lg border border-border p-4">
			<div class="text-xs uppercase tracking-wider text-muted-foreground">
				Adds to cart
			</div>
			<div class="mt-1 text-3xl font-semibold tabular-nums">
				{a.addsToCart.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-muted-foreground">
				{pct(a.addToCartRate)} of views
			</div>
		</div>
		<div class="rounded-lg border border-border p-4">
			<div class="text-xs uppercase tracking-wider text-muted-foreground">
				Purchases
			</div>
			<div class="mt-1 text-3xl font-semibold tabular-nums">
				{a.purchases.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-muted-foreground">
				{pct(a.purchaseRate)} of adds-to-cart
			</div>
		</div>
	</div>

	<section class="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
		Revenue attribution + per-line purchase events land in 4c.
		Until then, purchase count is 0 — purchases are only recorded
		at the order level, not per-product.
	</section>
</div>
