<script lang="ts">
	import { resolve } from '$app/paths';
	import { BarChart3 } from 'lucide-svelte';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import * as m from '$lib/paraglide/messages';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const a = $derived(data.analytics);
	function pct(x: number): string {
		return `${Math.round(x * 1000) / 10}%`;
	}
</script>

<PageShell>
	<PageHeader
		title={m.shop_admin_analytics()}
		description={m.shop_admin_analytics_desc({ title: data.productTitle, days: String(a.windowDays) })}
		icon={BarChart3}
		breadcrumbs={[
			{ label: m.shop_admin_products(), href: resolve('/(admin)/admin/shop/products') },
			{
				label: data.productTitle,
				href: resolve('/(admin)/admin/shop/products/[id]', { id: data.productId })
			},
			{ label: m.shop_admin_analytics() }
		]}
	/>

	<div class="grid gap-4 sm:grid-cols-3">
		<div class="rounded-lg border border-border p-4">
			<div class="text-xs uppercase tracking-wider text-muted-foreground">{m.shop_admin_views()}</div>
			<div class="mt-1 text-3xl font-semibold tabular-nums">
				{a.productViews.toLocaleString()}
			</div>
		</div>
		<div class="rounded-lg border border-border p-4">
			<div class="text-xs uppercase tracking-wider text-muted-foreground">
				{m.shop_admin_adds_to_cart()}
			</div>
			<div class="mt-1 text-3xl font-semibold tabular-nums">
				{a.addsToCart.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-muted-foreground">
				{m.shop_admin_pct_of_views({ pct: pct(a.addToCartRate) })}
			</div>
		</div>
		<div class="rounded-lg border border-border p-4">
			<div class="text-xs uppercase tracking-wider text-muted-foreground">
				{m.shop_admin_purchases()}
			</div>
			<div class="mt-1 text-3xl font-semibold tabular-nums">
				{a.purchases.toLocaleString()}
			</div>
			<div class="mt-1 text-xs text-muted-foreground">
				{m.shop_admin_pct_of_adds({ pct: pct(a.purchaseRate) })}
			</div>
		</div>
	</div>

	<section
		class="mt-6 rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground"
	>
		{m.shop_admin_analytics_note()}
	</section>
</PageShell>
