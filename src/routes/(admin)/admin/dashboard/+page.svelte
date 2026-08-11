<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
	import { LayoutDashboard } from 'lucide-svelte';
	import { PageShell, PageHeader, StatusBadge } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const stats = $derived(data.stats);
	const drafts = $derived(data.drafts);
	const scheduled = $derived(data.scheduled);
	const coverage = $derived(data.coverage);
	const activity = $derived(data.activity);

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
		if (md && typeof md === 'object' && !Array.isArray(md)) {
			const title = (md as Record<string, unknown>).title;
			if (typeof title === 'string' && title) return title;
			const slug = (md as Record<string, unknown>).slug;
			if (typeof slug === 'string' && slug) return slug;
			const name = (md as Record<string, unknown>).name;
			if (typeof name === 'string' && name) return name;
		}
		return row.entityId.slice(0, 8);
	}

	function pct(part: number, total: number): number {
		if (total === 0) return 0;
		return Math.round((part / total) * 100);
	}
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

	<div class="space-y-6">
	<!--
		Hierarchy: published count is the one number that answers "is the site
		healthy?", so it gets a full card and 5xl type. The other five stats
		were previously the same visual weight, which flattened the page into
		six equal claims on attention; they are now a dense secondary row.
	-->
	<section class="grid gap-3 lg:grid-cols-3">
		<Card class="lg:col-span-1">
			<CardContent class="p-6">
				<div class="text-sm font-medium text-muted-foreground">{m.cms_stat_published()}</div>
				<div class="mt-2 text-5xl font-semibold tabular-nums tracking-tight">
					{stats.published}
				</div>
				<div class="mt-2 text-xs text-muted-foreground">
					{m.cms_stat_articles()}: {stats.total}
				</div>
				<Button
					variant="outline"
					size="sm"
					class="mt-4"
					href={resolve('/(admin)/admin/articles')}
				>
					{m.cms_quick_browse_articles()}
				</Button>
			</CardContent>
		</Card>

		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:col-span-2 lg:content-start">
			<Card>
				<CardContent class="p-3">
					<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_articles()}</div>
					<div class="mt-0.5 text-xl font-semibold tabular-nums">{stats.total}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="p-3">
					<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_drafts()}</div>
					<div class="mt-0.5 text-xl font-semibold tabular-nums">{stats.drafts}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="p-3">
					<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_scheduled()}</div>
					<div class="mt-0.5 text-xl font-semibold tabular-nums">{stats.scheduled}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="p-3">
					<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_media()}</div>
					<div class="mt-0.5 text-xl font-semibold tabular-nums">{stats.media}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="p-3">
					<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_users()}</div>
					<div class="mt-0.5 text-xl font-semibold tabular-nums">{stats.users}</div>
				</CardContent>
			</Card>
		</div>
	</section>

	<!-- Shop (#160 C9): plugin-gated, admin+ — data.shop is null otherwise. -->
	{#if data.shop}
		<section class="space-y-3">
			<h2 class="text-sm font-medium text-muted-foreground">{m.shop_dashboard_title()}</h2>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Card>
					<CardContent class="p-3">
						<div class="text-xs font-medium text-muted-foreground">
							{m.shop_dashboard_orders_today()}
						</div>
						<div class="mt-0.5 text-xl font-semibold tabular-nums">{data.shop.today.orders}</div>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="p-3">
						<div class="text-xs font-medium text-muted-foreground">
							{m.shop_dashboard_revenue_today()}
						</div>
						<div class="mt-0.5 text-xl font-semibold tabular-nums">
							{formatSatang(data.shop.today.revenueSatang as Satang)}
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="p-3">
						<div class="text-xs font-medium text-muted-foreground">
							{m.shop_dashboard_orders_7d()}
						</div>
						<div class="mt-0.5 text-xl font-semibold tabular-nums">{data.shop.week.orders}</div>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="p-3">
						<div class="text-xs font-medium text-muted-foreground">
							{m.shop_dashboard_revenue_7d()}
						</div>
						<div class="mt-0.5 text-xl font-semibold tabular-nums">
							{formatSatang(data.shop.week.revenueSatang as Satang)}
						</div>
					</CardContent>
				</Card>
			</div>

			<div class="grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle class="text-sm flex items-center justify-between">
							<span>{m.shop_dashboard_recent_orders()}</span>
							<a
								href={resolve('/(admin)/admin/shop/orders')}
								class="text-xs text-muted-foreground hover:text-foreground"
							>
								{m.cms_dashboard_view_all()}
							</a>
						</CardTitle>
					</CardHeader>
					<CardContent class="p-0">
						{#if data.shop.recentOrders.length === 0}
							<div class="p-4 text-sm text-muted-foreground">
								{m.shop_dashboard_orders_empty()}
							</div>
						{:else}
							<ul class="divide-y divide-border">
								{#each data.shop.recentOrders as order (order.id)}
									<li>
										<a
											href={resolve('/(admin)/admin/shop/orders/[id]', { id: order.id })}
											class="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
										>
											<div class="flex-1 min-w-0">
												<div class="text-sm font-medium truncate">{order.orderNumber}</div>
												<div class="text-xs text-muted-foreground truncate">{order.email}</div>
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
					<CardHeader>
						<CardTitle class="text-sm">{m.shop_dashboard_low_stock()}</CardTitle>
					</CardHeader>
					<CardContent class="p-0">
						{#if data.shop.lowStock.length === 0}
							<div class="p-4 text-sm text-muted-foreground">
								{m.shop_dashboard_low_stock_empty()}
							</div>
						{:else}
							<ul class="divide-y divide-border">
								{#each data.shop.lowStock as row (row.variantId)}
									<li>
										<a
											href={resolve('/(admin)/admin/shop/products/[id]', { id: row.productId })}
											class="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
										>
											<div class="flex-1 min-w-0">
												<div class="text-sm font-medium truncate">
													{row.productTitle ?? row.variantTitle}
												</div>
												{#if row.productTitle && row.variantTitle}
													<div class="text-xs text-muted-foreground truncate">
														{row.variantTitle}
													</div>
												{/if}
											</div>
											<span class="text-sm tabular-nums {row.available <= 0 ? 'text-destructive' : 'text-muted-foreground'}">
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

	<!-- Quick actions: secondary to the metrics above, so ghost-weight links. -->
	<section class="grid gap-3 grid-cols-2 md:grid-cols-4">
		<a
			href={resolve('/(admin)/admin/articles/new')}
			class="group rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
		>
			<div class="flex items-center gap-2 text-sm font-medium">
				<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
				{m.cms_quick_new_article()}
			</div>
			<div class="text-xs text-muted-foreground mt-1">{m.cms_quick_new_article_help()}</div>
		</a>
		<a
			href={resolve('/(admin)/admin/media')}
			class="group rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
		>
			<div class="flex items-center gap-2 text-sm font-medium">
				<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5 5 5M12 5v12" /></svg>
				{m.cms_quick_upload_media()}
			</div>
			<div class="text-xs text-muted-foreground mt-1">{m.cms_quick_upload_media_help()}</div>
		</a>
		<a
			href={resolve('/(admin)/admin/categories')}
			class="group rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
		>
			<div class="flex items-center gap-2 text-sm font-medium">
				<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7h18M3 12h18M3 17h18" /></svg>
				{m.cms_quick_taxonomy()}
			</div>
			<div class="text-xs text-muted-foreground mt-1">{m.cms_quick_taxonomy_help()}</div>
		</a>
		<a
			href={data.showActivity ? resolve('/(admin)/admin/users') : resolve('/(admin)/admin/articles')}
			class="group rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
		>
			<div class="flex items-center gap-2 text-sm font-medium">
				<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a8 8 0 0 1 16 0v1" /></svg>
				{data.showActivity ? m.cms_quick_users() : m.cms_quick_browse_articles()}
			</div>
			<div class="text-xs text-muted-foreground mt-1">
				{data.showActivity ? m.cms_quick_users_help() : m.cms_quick_browse_articles_help()}
			</div>
		</a>
	</section>

	<div class="grid gap-4 lg:grid-cols-2">
		<!-- Scheduled -->
		<Card>
			<CardHeader>
				<CardTitle class="text-sm flex items-center justify-between">
					<span>{m.cms_dashboard_scheduled_title()}</span>
					{#if stats.scheduled > 0}
						<Badge variant="outline">{stats.scheduled}</Badge>
					{/if}
				</CardTitle>
			</CardHeader>
			<CardContent class="p-0">
				{#if scheduled.length === 0}
					<div class="p-4 text-sm text-muted-foreground">{m.cms_dashboard_scheduled_empty()}</div>
				{:else}
					<ul class="divide-y divide-border">
						{#each scheduled as a (a.id)}
							<li>
								<a
									href={resolve('/(admin)/admin/articles/[id]', { id: a.id })}
									class="block px-4 py-3 hover:bg-muted/40 transition-colors"
								>
									<div class="text-sm font-medium truncate">{a.title}</div>
									<div class="text-xs text-muted-foreground mt-0.5">
										{relativeTime(a.publishedAt)} · {a.slug}
									</div>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</CardContent>
		</Card>

		<!-- Recent drafts -->
		<Card>
			<CardHeader>
				<CardTitle class="text-sm flex items-center justify-between">
					<span>{m.cms_dashboard_drafts_title()}</span>
					<a href={resolve('/(admin)/admin/articles?status=draft')} class="text-xs text-muted-foreground hover:text-foreground">
						{m.cms_dashboard_view_all()}
					</a>
				</CardTitle>
			</CardHeader>
			<CardContent class="p-0">
				{#if drafts.length === 0}
					<div class="p-4 text-sm text-muted-foreground">{m.cms_dashboard_drafts_empty()}</div>
				{:else}
					<ul class="divide-y divide-border">
						{#each drafts as d (d.id)}
							<li>
								<a
									href={resolve('/(admin)/admin/articles/[id]', { id: d.id })}
									class="block px-4 py-3 hover:bg-muted/40 transition-colors"
								>
									<div class="text-sm font-medium truncate">{d.title}</div>
									<div class="text-xs text-muted-foreground mt-0.5">{relativeTime(d.updatedAt)}</div>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</CardContent>
		</Card>
	</div>

	<!-- i18n coverage -->
	{#if coverage.total > 0}
		<Card class="border-primary/30">
			<CardHeader>
				<CardTitle class="text-base">{m.cms_dashboard_coverage_title()}</CardTitle>
			</CardHeader>
			<CardContent class="space-y-3">
				<p class="text-xs text-muted-foreground">{m.cms_dashboard_coverage_help()}</p>
				<div class="space-y-2">
					<div>
						<div class="flex items-center justify-between text-xs font-medium">
							<span>EN</span>
							<span class="text-muted-foreground">
								{coverage.en} / {coverage.total} ({pct(coverage.en, coverage.total)}%)
							</span>
						</div>
						<div class="mt-1 h-2 rounded-full bg-muted overflow-hidden">
							<div
								class="h-full bg-primary"
								style="width: {pct(coverage.en, coverage.total)}%"
							></div>
						</div>
					</div>
					<div>
						<div class="flex items-center justify-between text-xs font-medium">
							<span>TH</span>
							<span class="text-muted-foreground">
								{coverage.th} / {coverage.total} ({pct(coverage.th, coverage.total)}%)
							</span>
						</div>
						<div class="mt-1 h-2 rounded-full bg-muted overflow-hidden">
							<div
								class="h-full bg-primary"
								style="width: {pct(coverage.th, coverage.total)}%"
							></div>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	{/if}

	<!-- Performance: top articles + search insights (v1.8) -->
	<div class="grid gap-4 lg:grid-cols-2">
		<Card>
			<CardHeader>
				<CardTitle class="text-sm">{m.cms_dashboard_top_articles()}</CardTitle>
			</CardHeader>
			<CardContent class="p-0">
				{#if data.topArticles.length === 0}
					<div class="p-4 text-sm text-muted-foreground">
						{m.cms_dashboard_analytics_empty()}
					</div>
				{:else}
					<ul class="divide-y divide-border">
						{#each data.topArticles as r, i (r.path)}
							<li class="flex items-center gap-3 px-4 py-2.5">
								<span class="text-xs text-muted-foreground tabular-nums w-5">#{i + 1}</span>
								<div class="flex-1 min-w-0">
									{#if r.articleId}
										<a href={resolve('/(admin)/admin/articles/[id]', { id: r.articleId })} class="text-sm font-medium hover:underline truncate block">
											{r.title}
										</a>
									{:else}
										<span class="text-sm font-medium truncate block">{r.title}</span>
									{/if}
									<span class="text-xs text-muted-foreground font-mono truncate block">{r.path}</span>
								</div>
								<span class="text-sm tabular-nums text-muted-foreground">{r.total}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader>
				<CardTitle class="text-sm">{m.cms_dashboard_search_insights()}</CardTitle>
			</CardHeader>
			<CardContent class="p-4 space-y-4">
				<div>
					<p class="text-xs font-medium text-muted-foreground mb-2">
						{m.cms_dashboard_top_search_terms()}
					</p>
					{#if data.topSearchTerms.length === 0}
						<p class="text-xs text-muted-foreground">{m.cms_dashboard_analytics_empty()}</p>
					{:else}
						<ul class="space-y-1">
							{#each data.topSearchTerms as t (t.term)}
								<li class="flex items-center justify-between text-sm">
									<a
										href={resolve(
											`/(www)/${getLocale()}/blog?q=${encodeURIComponent(t.term)}`,
										)}
										class="font-medium truncate hover:underline"
									>
										{t.term}
									</a>
									<span class="text-xs tabular-nums text-muted-foreground shrink-0 ml-2">
										{t.hits}
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				<div>
					<p class="text-xs font-medium text-muted-foreground mb-2">
						{m.cms_dashboard_no_result_terms()}
					</p>
					{#if data.noResultTerms.length === 0}
						<p class="text-xs text-muted-foreground">
							{m.cms_dashboard_no_result_empty()}
						</p>
					{:else}
						<ul class="space-y-1">
							{#each data.noResultTerms as t (t.term)}
								<li class="flex items-center justify-between text-sm">
									<span class="font-medium truncate">{t.term}</span>
									<span class="text-xs tabular-nums text-muted-foreground shrink-0 ml-2">
										{t.hits}
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</CardContent>
		</Card>
	</div>

	<!-- Activity -->
	{#if data.showActivity}
		<Card>
			<CardHeader>
				<CardTitle class="text-sm flex items-center justify-between">
					<span>{m.cms_dashboard_activity_title()}</span>
					<a href={resolve('/(admin)/admin/audit')} class="text-xs text-muted-foreground hover:text-foreground">
						{m.cms_dashboard_view_all()}
					</a>
				</CardTitle>
			</CardHeader>
			<CardContent class="p-0">
				{#if activity.length === 0}
					<div class="p-4 text-sm text-muted-foreground">{m.cms_dashboard_activity_empty()}</div>
				{:else}
					<ul class="divide-y divide-border">
						{#each activity as row (row.id)}
							<li class="px-4 py-3">
								<div class="flex items-center gap-2 flex-wrap text-sm">
									<span class="font-medium truncate">{row.actorName ?? row.actorEmail ?? m.cms_dashboard_unknown_actor()}</span>
									<Badge variant={actionVariant(row.action)} class="text-[10px]">
										{row.action}
									</Badge>
									<span class="text-muted-foreground truncate">{entityLabel(row)}</span>
									<span class="ml-auto text-xs text-muted-foreground">{relativeTime(row.createdAt)}</span>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</CardContent>
		</Card>
	{/if}
	</div>
</PageShell>
