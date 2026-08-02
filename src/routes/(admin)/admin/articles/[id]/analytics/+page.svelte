<script lang="ts">
	import { resolve } from '$app/paths';
	import { BarChart3 } from 'lucide-svelte';
	import { Badge } from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const buckets = $derived(data.analytics.scrollDepthBuckets);
	const bucketMax = $derived(
		Math.max(1, buckets['0-24'], buckets['25-49'], buckets['50-74'], buckets['75-100']),
	);
	function formatDuration(ms: number | null): string {
		if (ms == null) return '—';
		if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
		const min = Math.floor(ms / 60_000);
		const sec = Math.round((ms % 60_000) / 1000);
		return `${min}m ${sec}s`;
	}
</script>

<PageShell width="default">
	<PageHeader
		title="Analytics"
		description="{data.articleTitle} · past {data.analytics.windowDays} days"
		icon={BarChart3}
		breadcrumbs={[
			{ label: 'Articles', href: resolve('/(admin)/admin/articles') },
			{
				label: data.articleTitle,
				href: resolve('/(admin)/admin/articles/[id]', { id: data.articleId }),
			},
			{ label: 'Analytics' },
		]}
	/>

	<div class="space-y-6">
		<div class="grid gap-4 sm:grid-cols-3">
			<div class="rounded-lg border border-border bg-card p-4">
				<div class="text-xs uppercase tracking-wider text-muted-foreground">Reads</div>
				<div class="mt-1 text-3xl font-semibold tabular-nums">
					{data.analytics.articleReads.toLocaleString()}
				</div>
			</div>
			<div class="rounded-lg border border-border bg-card p-4">
				<div class="text-xs uppercase tracking-wider text-muted-foreground">Median dwell</div>
				<div class="mt-1 text-3xl font-semibold tabular-nums">
					{formatDuration(data.analytics.medianReadTimeMs)}
				</div>
			</div>
			<div class="rounded-lg border border-border bg-card p-4">
				<div class="text-xs uppercase tracking-wider text-muted-foreground">
					Attributed purchases
				</div>
				<div class="mt-1 text-3xl font-semibold tabular-nums">
					{data.analytics.attributedPurchases}
				</div>
			</div>
		</div>

		<section class="rounded-lg border border-border bg-card p-4">
			<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Scroll depth
			</h2>
			{#if data.analytics.articleReads === 0}
				<p class="text-sm text-muted-foreground">No reads yet.</p>
			{:else}
				<div class="space-y-2">
					{#each Object.entries(buckets) as [range, count] (range)}
						<div class="flex items-center gap-3">
							<div class="w-16 text-xs text-muted-foreground">{range}%</div>
							<div class="h-6 flex-1 overflow-hidden rounded bg-muted">
								<div class="h-full bg-primary" style="width: {(count / bucketMax) * 100}%"></div>
							</div>
							<div class="w-12 text-right text-xs tabular-nums">{count}</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<section class="rounded-lg border border-border bg-card p-4">
			<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Top referrers
			</h2>
			{#if data.analytics.topReferrers.length === 0}
				<p class="text-sm text-muted-foreground">No external referrers recorded.</p>
			{:else}
				<ul class="space-y-1 text-sm">
					{#each data.analytics.topReferrers as ref (ref.origin)}
						<li class="flex items-center justify-between border-b border-border pb-1">
							<span>{ref.origin}</span>
							<Badge variant="secondary">{ref.count}</Badge>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</PageShell>
