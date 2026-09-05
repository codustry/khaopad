<script lang="ts">
	/**
	 * The admin dashboard.
	 *
	 * ## The ordering principle
	 *
	 * Act first, context second, reference last. The page is three bands:
	 *
	 *   1. NEEDS YOU  — work items. Drafts, the scheduled queue, and the
	 *                   searches that returned nothing (each one a brief
	 *                   for an article that does not exist yet).
	 *   2. REACH      — is the site growing? Views with a direction of
	 *                   travel, the daily trend, and the articles that
	 *                   produced it.
	 *   3. REFERENCE  — translation coverage when it is incomplete, and
	 *                   the audit feed. Neither is news; both are useful
	 *                   to look up.
	 *
	 * ## What was removed, and why
	 *
	 * The previous version showed six equal-weight counters. `Articles`
	 * was printed twice (as the headline's sub-line AND its own tile);
	 * `Media Files` and `Users` drive no decision from a dashboard and
	 * live on their own pages; and `Published` was the page's biggest
	 * number despite being a stock that only moves when you move it —
	 * it cannot be news. Total views, the one number an operator
	 * actually checks, was absent entirely.
	 *
	 * The test each surviving number has to pass: what would an operator
	 * DO differently on seeing it change?
	 */
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
	import { LayoutDashboard } from 'lucide-svelte';
	import {
		PageShell,
		PageHeader,
		StatusBadge,
		MetricTile,
		EmptyState,
		TrendChart,
		Sparkline
	} from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const stats = $derived(data.stats);
	const drafts = $derived(data.drafts);
	const scheduled = $derived(data.scheduled);
	const coverage = $derived(data.coverage);
	const activity = $derived(data.activity);

	/** A site with nothing published yet gets a single instruction, not 8 empty panels. */
	const isFreshInstall = $derived(stats.total === 0);

	// ── Reach ────────────────────────────────────────────────
	const views = $derived(data.viewsCompared);
	const hasViews = $derived((views?.current ?? 0) > 0);

	/**
	 * Percentage change vs the previous 30 days, or `null` when there is
	 * no basis for one. The loader already reports `previous: null` for a
	 * window with no data, because "+100% on zero" is not a fact.
	 */
	const viewsDelta = $derived.by(() => {
		if (!views || views.previous === null || views.previous === 0) return null;
		return Math.round(((views.current - views.previous) / views.previous) * 100);
	});

	const deltaTone = $derived(
		viewsDelta === null ? 'neutral' : viewsDelta > 0 ? 'good' : viewsDelta < 0 ? 'warn' : 'neutral'
	);

	/** Locale-aware thousands separators; `964` reads worse as `964` at 4+ digits. */
	function num(n: number): string {
		return n.toLocaleString(getLocale() === 'th' ? 'th-TH' : 'en-US');
	}

	function relativeTime(iso: string): string {
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return iso;
		const diff = then - Date.now();
		const abs = Math.abs(diff);
		const sec = Math.round(abs / 1000);
		if (sec < 60) return diff < 0 ? `${sec}s ago` : `in ${sec}s`;
		const min = Math.round(sec / 60);
		if (min < 60) return diff < 0 ? `${min}m ago` : `in ${min}m`;
		const hr = Math.round(min / 60);
		if (hr < 24) return diff < 0 ? `${hr}h ago` : `in ${hr}h`;
		const day = Math.round(hr / 24);
		if (day < 30) return diff < 0 ? `${day}d ago` : `in ${day}d`;
		const mo = Math.round(day / 30);
		return diff < 0 ? `${mo}mo ago` : `in ${mo}mo`;
	}

	/** Map an audit action verb to a Badge variant. */
	function actionVariant(action: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		const verb = action.split('.').pop() ?? '';
		if (['create', 'accept', 'publish'].includes(verb)) return 'default';
		if (['delete', 'revoke', 'unpublish'].includes(verb)) return 'destructive';
		return 'secondary';
	}

	/** Best-effort label for an audit row. */
	function entityLabel(row: (typeof activity)[number]): string {
		const md = row.metadata;
		if (md && typeof md === 'object' && 'title' in md && typeof md.title === 'string') {
			return md.title;
		}
		if (md && typeof md === 'object' && 'slug' in md && typeof md.slug === 'string') {
			return md.slug;
		}
		return `${row.entityType} ${row.entityId.slice(0, 8)}`;
	}

	function pct(part: number, total: number): number {
		if (total === 0) return 0;
		return Math.round((part / total) * 100);
	}

	/**
	 * Coverage is shown only when a locale is BEHIND. At 100% it is a
	 * congratulation, not information, and a permanently-green bar
	 * teaches the eye to skip that region of the page.
	 */
	const coverageIncomplete = $derived(
		coverage.total > 0 && (coverage.en < coverage.total || coverage.th < coverage.total)
	);
</script>

<svelte:head>
	<title>{m.cms_dashboard()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader
		title={m.cms_dashboard()}
		description={m.cms_dashboard_welcome()}
		icon={LayoutDashboard}
	>
		{#snippet actions()}
			{#if stats.newThisWeek > 0}
				<Badge variant="secondary">
					{m.cms_dashboard_new_this_week({ count: stats.newThisWeek })}
				</Badge>
			{/if}
			<Button href={resolve('/(admin)/admin/articles/new')}>
				{m.cms_quick_new_article()}
			</Button>
		{/snippet}
	</PageHeader>

	{#if isFreshInstall}
		<!--
			A brand-new install used to render eight panels, six of them
			empty — which reads as a broken deployment rather than a new
			one. One instruction is more useful and more honest.
		-->
		<EmptyState title={m.cms_dashboard_start_title()} description={m.cms_dashboard_start_body()}>
			{#snippet action()}
				<Button href={resolve('/(admin)/admin/articles/new')}>
					{m.cms_quick_new_article()}
				</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="space-y-8">
			<!-- ─────────────── 1. NEEDS YOU ─────────────── -->
			<section class="space-y-3">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{m.cms_dashboard_needs_you()}
				</h2>

				<div class="grid gap-4 lg:grid-cols-3">
					<!-- Drafts -->
					<Card>
						<CardHeader class="pb-3">
							<CardTitle class="flex items-center justify-between text-sm">
								<span>{m.cms_dashboard_drafts_title()}</span>
								<a
									href={resolve('/(admin)/admin/articles?status=draft')}
									class="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
								>
									{m.cms_dashboard_view_all()}
								</a>
							</CardTitle>
						</CardHeader>
						<CardContent class="p-0">
							{#if drafts.length === 0}
								<div class="px-4 pb-4">
									<EmptyState
										size="sm"
										title={m.cms_dashboard_drafts_empty_title()}
										description={m.cms_dashboard_drafts_empty_body()}
									/>
								</div>
							{:else}
								<ul class="divide-y divide-border">
									{#each drafts as d (d.id)}
										<li>
											<a
												href={resolve('/(admin)/admin/articles/[id]', { id: d.id })}
												class="block px-4 py-2.5 transition-colors hover:bg-muted/40"
											>
												<div class="truncate text-sm font-medium">{d.title}</div>
												<div class="mt-0.5 text-xs text-muted-foreground">
													{relativeTime(d.updatedAt)}
												</div>
											</a>
										</li>
									{/each}
								</ul>
							{/if}
						</CardContent>
					</Card>

					<!-- Scheduled -->
					<Card>
						<CardHeader class="pb-3">
							<CardTitle class="flex items-center justify-between text-sm">
								<span>{m.cms_dashboard_scheduled_title()}</span>
								{#if stats.scheduled > 0}
									<Badge variant="outline">{stats.scheduled}</Badge>
								{/if}
							</CardTitle>
						</CardHeader>
						<CardContent class="p-0">
							{#if scheduled.length === 0}
								<div class="px-4 pb-4">
									<EmptyState
										size="sm"
										title={m.cms_dashboard_scheduled_empty_title()}
										description={m.cms_dashboard_scheduled_empty_body()}
									/>
								</div>
							{:else}
								<ul class="divide-y divide-border">
									{#each scheduled as a (a.id)}
										<li>
											<a
												href={resolve('/(admin)/admin/articles/[id]', { id: a.id })}
												class="block px-4 py-2.5 transition-colors hover:bg-muted/40"
											>
												<div class="truncate text-sm font-medium">{a.title}</div>
												<div class="mt-0.5 text-xs text-muted-foreground">
													{relativeTime(a.publishedAt)} · {a.slug}
												</div>
											</a>
										</li>
									{/each}
								</ul>
							{/if}
						</CardContent>
					</Card>

					<!--
						Content gaps. Promoted out of the bottom half of a
						"Search insights" card: this is the most directly
						actionable list on the page — visitors asked for
						these in their own words and got nothing.
					-->
					<Card>
						<CardHeader class="pb-3">
							<CardTitle class="text-sm">{m.cms_dashboard_gaps_title()}</CardTitle>
						</CardHeader>
						<CardContent class="p-0">
							{#if data.noResultTerms.length === 0}
								<div class="px-4 pb-4">
									<EmptyState
										size="sm"
										title={m.cms_dashboard_gaps_empty_title()}
										description={m.cms_dashboard_gaps_empty_body()}
									/>
								</div>
							{:else}
								<p class="px-4 pb-2 text-xs text-muted-foreground">
									{m.cms_dashboard_gaps_help()}
								</p>
								<ul class="divide-y divide-border">
									{#each data.noResultTerms as t (t.term)}
										<li class="flex items-center justify-between gap-2 px-4 py-2.5">
											<span class="truncate text-sm font-medium">{t.term}</span>
											<span class="shrink-0 text-xs tabular-nums text-muted-foreground">
												{t.hits}
											</span>
										</li>
									{/each}
								</ul>
							{/if}
						</CardContent>
					</Card>
				</div>
			</section>

			<!-- ─────────────── 2. REACH ─────────────── -->
			<section class="space-y-3">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{m.cms_dashboard_reach()}
				</h2>

				<div class="grid gap-4 lg:grid-cols-3">
					<!-- Headline number + trend -->
					<Card class="lg:col-span-2">
						<CardContent class="space-y-4 p-4 sm:p-6">
							<div class="flex flex-wrap items-baseline justify-between gap-2">
								<div>
									<div class="text-xs font-medium text-muted-foreground">
										{m.cms_dashboard_views_30d()}
									</div>
									<div class="mt-1 flex items-baseline gap-2">
										<span class="text-3xl font-semibold tabular-nums tracking-tight">
											{views ? num(views.current) : '—'}
										</span>
										{#if viewsDelta !== null}
											<!--
												Tone colours the NUMBER, never the card. A tinted
												card makes every panel shout at one volume.
											-->
											<span
												class="text-sm font-medium tabular-nums {deltaTone === 'good'
													? 'text-green-600 dark:text-green-400'
													: deltaTone === 'warn'
														? 'text-amber-600 dark:text-amber-400'
														: 'text-muted-foreground'}"
											>
												{viewsDelta > 0 ? '+' : ''}{viewsDelta}%
											</span>
										{/if}
									</div>
									<div class="mt-0.5 text-xs text-muted-foreground">
										{viewsDelta !== null
											? m.cms_dashboard_views_vs_previous()
											: m.cms_dashboard_views_no_baseline()}
									</div>
								</div>
							</div>

							{#if hasViews && data.dailyViews.length > 0}
								<TrendChart points={data.dailyViews} label={m.cms_dashboard_trend_label()} />
							{:else}
								<EmptyState
									size="sm"
									title={m.cms_dashboard_trend_empty_title()}
									description={m.cms_dashboard_trend_empty_body()}
								/>
							{/if}
						</CardContent>
					</Card>

					<!-- Publishing posture: only the counts a decision follows from. -->
					<div class="grid grid-cols-2 gap-3 lg:grid-cols-1 lg:content-start">
						<MetricTile
							label={m.cms_stat_published()}
							value={stats.published}
							href={resolve('/(admin)/admin/articles')}
						/>
						<MetricTile
							label={m.cms_stat_drafts()}
							value={stats.drafts}
							tone={stats.drafts > 0 ? 'warn' : 'neutral'}
							href={resolve('/(admin)/admin/articles?status=draft')}
						/>
					</div>
				</div>

				<!-- Top articles, each with its own 14-day shape. -->
				<Card>
					<CardHeader class="pb-3">
						<CardTitle class="text-sm">{m.cms_dashboard_top_articles()}</CardTitle>
					</CardHeader>
					<CardContent class="p-0">
						{#if data.topArticles.length === 0}
							<div class="px-4 pb-4">
								<EmptyState
									size="sm"
									title={m.cms_dashboard_top_articles_empty_title()}
									description={m.cms_dashboard_top_articles_empty_body()}
								/>
							</div>
						{:else}
							<ul class="divide-y divide-border">
								{#each data.topArticles as r, i (r.path)}
									<li class="flex items-center gap-3 px-4 py-2.5">
										<span class="w-5 text-xs tabular-nums text-muted-foreground">#{i + 1}</span>
										<div class="min-w-0 flex-1">
											{#if r.articleId}
												<a
													href={resolve('/(admin)/admin/articles/[id]', { id: r.articleId })}
													class="block truncate text-sm font-medium hover:underline"
												>
													{r.title}
												</a>
											{:else}
												<span class="block truncate text-sm font-medium">{r.title}</span>
											{/if}
											<span class="block truncate font-mono text-xs text-muted-foreground">
												{r.path}
											</span>
										</div>
										{#if r.spark.length > 0}
											<div class="hidden w-24 shrink-0 sm:block">
												<Sparkline points={r.spark} label={m.cms_dashboard_spark_label()} />
											</div>
										{/if}
										<span class="w-14 shrink-0 text-right text-sm tabular-nums">
											{num(r.total)}
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					</CardContent>
				</Card>
			</section>

			<!-- Shop (#160 C9): plugin-gated, admin+ — data.shop is null otherwise. -->
			{#if data.shop}
				<section class="space-y-3">
					<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{m.shop_dashboard_title()}
					</h2>
					<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<MetricTile
							label={m.shop_dashboard_orders_today()}
							value={data.shop.today.orders}
							lead={data.shop.today.orders > 0}
						/>
						<MetricTile
							label={m.shop_dashboard_revenue_today()}
							value={formatSatang(data.shop.today.revenueSatang as Satang)}
						/>
						<MetricTile
							label={m.shop_dashboard_orders_7d()}
							value={data.shop.week.orders}
						/>
						<MetricTile
							label={m.shop_dashboard_revenue_7d()}
							value={formatSatang(data.shop.week.revenueSatang as Satang)}
						/>
					</div>

					<div class="grid gap-4 lg:grid-cols-2">
						<Card>
							<CardHeader class="pb-3">
								<CardTitle class="flex items-center justify-between text-sm">
									<span>{m.shop_dashboard_recent_orders()}</span>
									<a
										href={resolve('/(admin)/admin/shop/orders')}
										class="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
									>
										{m.cms_dashboard_view_all()}
									</a>
								</CardTitle>
							</CardHeader>
							<CardContent class="p-0">
								{#if data.shop.recentOrders.length === 0}
									<div class="px-4 pb-4">
										<EmptyState size="sm" title={m.shop_dashboard_orders_empty()} />
									</div>
								{:else}
									<ul class="divide-y divide-border">
										{#each data.shop.recentOrders as order (order.id)}
											<li>
												<a
													href={resolve('/(admin)/admin/shop/orders/[id]', { id: order.id })}
													class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
												>
													<div class="min-w-0 flex-1">
														<div class="truncate text-sm font-medium">{order.orderNumber}</div>
														<div class="truncate text-xs text-muted-foreground">{order.email}</div>
													</div>
													<StatusBadge status={order.financialStatus} />
													<span class="text-sm tabular-nums">
														{formatSatang(order.totalSatang as Satang)}
													</span>
												</a>
											</li>
										{/each}
									</ul>
								{/if}
							</CardContent>
						</Card>

						<Card>
							<CardHeader class="pb-3">
								<CardTitle class="text-sm">{m.shop_dashboard_low_stock()}</CardTitle>
							</CardHeader>
							<CardContent class="p-0">
								{#if data.shop.lowStock.length === 0}
									<div class="px-4 pb-4">
										<EmptyState size="sm" title={m.shop_dashboard_low_stock_empty()} />
									</div>
								{:else}
									<ul class="divide-y divide-border">
										{#each data.shop.lowStock as row (row.variantId)}
											<li>
												<a
													href={resolve('/(admin)/admin/shop/products/[id]', {
														id: row.productId
													})}
													class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
												>
													<div class="min-w-0 flex-1">
														<div class="truncate text-sm font-medium">
															{row.productTitle ?? row.variantTitle}
														</div>
														{#if row.productTitle && row.variantTitle}
															<div class="truncate text-xs text-muted-foreground">
																{row.variantTitle}
															</div>
														{/if}
													</div>
													<span
														class="text-sm tabular-nums {row.available <= 0
															? 'text-destructive'
															: 'text-muted-foreground'}"
													>
														{row.available}
													</span>
												</a>
											</li>
										{/each}
									</ul>
								{/if}
							</CardContent>
						</Card>
					</div>
				</section>
			{/if}

			<!-- ─────────────── 3. REFERENCE ─────────────── -->
			<section class="space-y-3">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{m.cms_dashboard_reference()}
				</h2>

				<div class="grid gap-4 lg:grid-cols-2">
					<!--
						Coverage only when a locale is behind. A permanently
						full green bar teaches the eye to skip this region.
					-->
					{#if coverageIncomplete}
						<Card>
							<CardHeader class="pb-3">
								<CardTitle class="text-sm">{m.cms_dashboard_coverage_title()}</CardTitle>
							</CardHeader>
							<CardContent class="space-y-3 p-4 pt-0">
								<p class="text-xs text-muted-foreground">{m.cms_dashboard_coverage_help()}</p>
								{#each [{ code: 'EN', done: coverage.en }, { code: 'TH', done: coverage.th }] as row (row.code)}
									<div>
										<div class="flex items-center justify-between text-xs font-medium">
											<span>{row.code}</span>
											<span class="tabular-nums text-muted-foreground">
												{row.done} / {coverage.total} ({pct(row.done, coverage.total)}%)
											</span>
										</div>
										<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
											<div
												class="h-full rounded-full bg-primary"
												style="width: {pct(row.done, coverage.total)}%"
											></div>
										</div>
									</div>
								{/each}
							</CardContent>
						</Card>
					{/if}

					<!-- Most-searched terms: interesting, not actionable. Reference. -->
					<Card>
						<CardHeader class="pb-3">
							<CardTitle class="text-sm">{m.cms_dashboard_top_search_terms()}</CardTitle>
						</CardHeader>
						<CardContent class="p-0">
							{#if data.topSearchTerms.length === 0}
								<div class="px-4 pb-4">
									<EmptyState
										size="sm"
										title={m.cms_dashboard_search_terms_empty_title()}
										description={m.cms_dashboard_search_terms_empty_body()}
									/>
								</div>
							{:else}
								<ul class="divide-y divide-border">
									{#each data.topSearchTerms as t (t.term)}
										<li class="flex items-center justify-between gap-2 px-4 py-2">
											<a
												href={resolve(`/(www)/${getLocale()}/blog?q=${encodeURIComponent(t.term)}`)}
												class="truncate rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
											>
												{t.term}
											</a>
											<span class="shrink-0 text-xs tabular-nums text-muted-foreground">
												{t.hits}
											</span>
										</li>
									{/each}
								</ul>
							{/if}
						</CardContent>
					</Card>
				</div>

				<!-- Activity -->
				{#if data.showActivity}
					<Card>
						<CardHeader class="pb-3">
							<CardTitle class="flex items-center justify-between text-sm">
								<span>{m.cms_dashboard_activity_title()}</span>
								<a
									href={resolve('/(admin)/admin/audit')}
									class="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
								>
									{m.cms_dashboard_view_all()}
								</a>
							</CardTitle>
						</CardHeader>
						<CardContent class="p-0">
							{#if activity.length === 0}
								<div class="px-4 pb-4">
									<EmptyState
										size="sm"
										title={m.cms_dashboard_activity_empty_title()}
										description={m.cms_dashboard_activity_empty_body()}
									/>
								</div>
							{:else}
								<ul class="divide-y divide-border">
									{#each activity as row (row.id)}
										<li class="px-4 py-2.5">
											<div class="flex flex-wrap items-center gap-2 text-sm">
												<span class="truncate font-medium">
													{row.actorName ?? row.actorEmail ?? m.cms_dashboard_unknown_actor()}
												</span>
												<Badge variant={actionVariant(row.action)} class="text-[10px]">
													{row.action}
												</Badge>
												<span class="truncate text-muted-foreground">{entityLabel(row)}</span>
												<span class="ml-auto text-xs text-muted-foreground">
													{relativeTime(row.createdAt)}
												</span>
											</div>
										</li>
									{/each}
								</ul>
							{/if}
						</CardContent>
					</Card>
				{/if}
			</section>
		</div>
	{/if}
</PageShell>
