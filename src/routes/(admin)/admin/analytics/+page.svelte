<script lang="ts">
	/**
	 * Visitor sources.
	 *
	 * A page of its own rather than a dashboard section: this is a
	 * five-table drill-down that wants `wide`, while the dashboard is a
	 * scannable card summary. It also does NOT belong under
	 * `/admin/reports`, which the shop plugin gates — general site
	 * acquisition data has to survive a site that sells nothing.
	 *
	 * The chart is inline SVG rather than a chart library: it is one
	 * 30-point series, and the admin bundle should not grow a charting
	 * dependency for it.
	 */
	import * as m from '$lib/paraglide/messages';
	import { TrendingUp } from 'lucide-svelte';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, type Column } from '$lib/components/admin';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type ChannelRow = PageData['byChannel'][number];
	type SourceRow = PageData['topSources'][number];
	type CampaignRow = PageData['topCampaigns'][number];
	type LandingRow = PageData['topLandingPages'][number];

	const total = $derived(data.total);
	const hasData = $derived(total > 0);

	/** Localized label for a channel key. */
	function channelLabel(channel: string): string {
		switch (channel) {
			case 'direct':
				return m.cms_analytics_channel_direct();
			case 'organic_search':
				return m.cms_analytics_channel_organic_search();
			case 'social':
				return m.cms_analytics_channel_social();
			case 'referral':
				return m.cms_analytics_channel_referral();
			case 'internal':
				return m.cms_analytics_channel_internal();
			default:
				return channel;
		}
	}

	function share(n: number): string {
		if (total === 0) return '0%';
		return `${Math.round((n / total) * 100)}%`;
	}

	const channelColumns: Column<ChannelRow>[] = $derived([
		{ key: 'channel', header: m.cms_analytics_col_channel(), cell: channelCell },
		{ key: 'total', header: m.cms_analytics_col_landings(), align: 'right', numeric: true },
		{ key: 'share', header: m.cms_analytics_col_share(), align: 'right', numeric: true, cell: shareCell }
	]);

	const sourceColumns: Column<SourceRow>[] = $derived([
		{ key: 'source', header: m.cms_analytics_col_source() },
		{ key: 'channel', header: m.cms_analytics_col_channel(), cell: sourceChannelCell },
		{ key: 'total', header: m.cms_analytics_col_landings(), align: 'right', numeric: true }
	]);

	const campaignColumns: Column<CampaignRow>[] = $derived([
		{ key: 'campaign', header: m.cms_analytics_col_campaign() },
		{ key: 'source', header: m.cms_analytics_col_source() },
		{ key: 'medium', header: m.cms_analytics_col_medium() },
		{ key: 'total', header: m.cms_analytics_col_landings(), align: 'right', numeric: true }
	]);

	const landingColumns: Column<LandingRow>[] = $derived([
		{ key: 'path', header: m.cms_analytics_col_path(), cell: pathCell },
		{ key: 'total', header: m.cms_analytics_col_landings(), align: 'right', numeric: true }
	]);

	// ── Sparkline geometry. Plotted on a 0..100 × 0..30 viewBox and
	//    stretched by CSS, so it stays crisp at any container width.
	const series = $derived(data.series);
	const peak = $derived(Math.max(1, ...series.map((p) => p.total)));
	const points = $derived(
		series
			.map((p, i) => {
				const x = series.length > 1 ? (i / (series.length - 1)) * 100 : 0;
				const y = 30 - (p.total / peak) * 28;
				return `${x.toFixed(2)},${y.toFixed(2)}`;
			})
			.join(' ')
	);
</script>

{#snippet channelCell(row: ChannelRow)}
	{channelLabel(row.channel)}
{/snippet}

{#snippet sourceChannelCell(row: SourceRow)}
	<span class="text-muted-foreground">{channelLabel(row.channel)}</span>
{/snippet}

{#snippet shareCell(row: ChannelRow)}
	{share(row.total)}
{/snippet}

{#snippet pathCell(row: LandingRow)}
	<span class="font-mono text-xs">{row.path}</span>
{/snippet}

<PageShell width="wide">
	<PageHeader
		title={m.cms_analytics_title()}
		description={m.cms_analytics_desc()}
		icon={TrendingUp}
	/>

	{#if !hasData}
		<Card>
			<CardContent class="py-10 text-center text-sm text-muted-foreground">
				{m.cms_analytics_empty()}
			</CardContent>
		</Card>
	{:else}
		<div class="space-y-6">
			<!-- Time series -->
			<Card>
				<CardHeader>
					<CardTitle>{m.cms_analytics_series()}</CardTitle>
				</CardHeader>
				<CardContent>
					<p class="mb-3 text-2xl font-semibold tabular-nums">
						{total.toLocaleString()}
						<span class="ml-2 text-sm font-normal text-muted-foreground">
							{m.cms_analytics_total()}
						</span>
					</p>
					<svg
						viewBox="0 0 100 30"
						preserveAspectRatio="none"
						class="h-24 w-full"
						role="img"
						aria-label={m.cms_analytics_series()}
					>
						<polyline
							{points}
							fill="none"
							stroke="currentColor"
							stroke-width="0.6"
							vector-effect="non-scaling-stroke"
							class="text-primary"
						/>
					</svg>
					<div class="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
						<span>{series[0]?.date}</span>
						<span>{series.at(-1)?.date}</span>
					</div>
				</CardContent>
			</Card>

			<div class="grid gap-6 lg:grid-cols-2">
				<!-- Channels -->
				<Card>
					<CardHeader>
						<CardTitle>{m.cms_analytics_by_channel()}</CardTitle>
					</CardHeader>
					<CardContent>
						<DataTable
							columns={channelColumns}
							rows={data.byChannel}
							getKey={(r) => r.channel}
							caption={m.cms_analytics_by_channel()}
						/>
					</CardContent>
				</Card>

				<!-- Top sources -->
				<Card>
					<CardHeader>
						<CardTitle>{m.cms_analytics_top_sources()}</CardTitle>
					</CardHeader>
					<CardContent>
						<DataTable
							columns={sourceColumns}
							rows={data.topSources}
							getKey={(r) => `${r.channel}:${r.source}`}
							caption={m.cms_analytics_top_sources()}
						/>
					</CardContent>
				</Card>

				<!-- Campaigns -->
				<Card>
					<CardHeader>
						<CardTitle>{m.cms_analytics_top_campaigns()}</CardTitle>
					</CardHeader>
					<CardContent>
						{#if data.topCampaigns.length === 0}
							<p class="py-6 text-center text-sm text-muted-foreground">
								{m.cms_analytics_no_campaigns()}
							</p>
						{:else}
							<DataTable
								columns={campaignColumns}
								rows={data.topCampaigns}
								getKey={(r) => `${r.campaign}:${r.source}:${r.medium}`}
								caption={m.cms_analytics_top_campaigns()}
							/>
						{/if}
					</CardContent>
				</Card>

				<!-- Landing pages -->
				<Card>
					<CardHeader>
						<CardTitle>{m.cms_analytics_top_landing()}</CardTitle>
					</CardHeader>
					<CardContent>
						<DataTable
							columns={landingColumns}
							rows={data.topLandingPages}
							getKey={(r) => r.path}
							caption={m.cms_analytics_top_landing()}
						/>
					</CardContent>
				</Card>
			</div>

			<p class="text-xs text-muted-foreground">
				{m.cms_analytics_privacy_note()}
			</p>
		</div>
	{/if}
</PageShell>
