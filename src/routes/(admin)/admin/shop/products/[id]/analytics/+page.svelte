<script lang="ts">
	import { resolve } from '$app/paths';
	import { BarChart3 } from 'lucide-svelte';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const a = $derived(data.analytics);
	function pct(x: number): string {
		return `${Math.round(x * 1000) / 10}%`;
	}
</script>

<PageShell>
	<PageHeader
		title="Analytics"
		description="{data.productTitle} · past {a.windowDays} days"
		icon={BarChart3}
		breadcrumbs={[
			{ label: 'Products', href: resolve('/(admin)/admin/shop/products') },
			{
				label: data.productTitle,
				href: resolve('/(admin)/admin/shop/products/[id]', { id: data.productId })
			},
			{ label: 'Analytics' }
		]}
	/>

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

	<section
		class="mt-6 rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground"
	>
		Revenue attribution + per-line purchase events land in 4c.
		Until then, purchase count is 0 — purchases are only recorded
		at the order level, not per-product.
	</section>
</PageShell>
