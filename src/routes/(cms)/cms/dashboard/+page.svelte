<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Badge, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
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

<div class="space-y-6">
	<header class="flex items-end justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_dashboard()}</h1>
			<p class="text-sm text-muted-foreground mt-1">
				{m.cms_dashboard_welcome()}
			</p>
		</div>
		{#if stats.newThisWeek > 0}
			<Badge variant="secondary">
				{m.cms_dashboard_new_this_week({ count: stats.newThisWeek })}
			</Badge>
		{/if}
	</header>

	<!-- Stats row -->
	<section class="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
		<Card>
			<CardContent class="p-4">
				<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_articles()}</div>
				<div class="text-2xl font-semibold mt-1">{stats.total}</div>
			</CardContent>
		</Card>
		<Card>
			<CardContent class="p-4">
				<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_published()}</div>
				<div class="text-2xl font-semibold mt-1">{stats.published}</div>
			</CardContent>
		</Card>
		<Card>
			<CardContent class="p-4">
				<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_drafts()}</div>
				<div class="text-2xl font-semibold mt-1">{stats.drafts}</div>
			</CardContent>
		</Card>
		<Card>
			<CardContent class="p-4">
				<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_scheduled()}</div>
				<div class="text-2xl font-semibold mt-1">{stats.scheduled}</div>
			</CardContent>
		</Card>
		<Card>
			<CardContent class="p-4">
				<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_media()}</div>
				<div class="text-2xl font-semibold mt-1">{stats.media}</div>
			</CardContent>
		</Card>
		<Card>
			<CardContent class="p-4">
				<div class="text-xs font-medium text-muted-foreground">{m.cms_stat_users()}</div>
				<div class="text-2xl font-semibold mt-1">{stats.users}</div>
			</CardContent>
		</Card>
	</section>

	<!-- Quick actions -->
	<section class="grid gap-3 grid-cols-2 md:grid-cols-4">
		<a
			href="/cms/articles/new"
			class="group rounded-lg border border-border bg-card p-4 hover:border-primary hover:bg-muted/40 transition-colors"
		>
			<div class="flex items-center gap-2 text-sm font-medium">
				<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
				{m.cms_quick_new_article()}
			</div>
			<div class="text-xs text-muted-foreground mt-1">{m.cms_quick_new_article_help()}</div>
		</a>
		<a
			href="/cms/media"
			class="group rounded-lg border border-border bg-card p-4 hover:border-primary hover:bg-muted/40 transition-colors"
		>
			<div class="flex items-center gap-2 text-sm font-medium">
				<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5 5 5M12 5v12" /></svg>
				{m.cms_quick_upload_media()}
			</div>
			<div class="text-xs text-muted-foreground mt-1">{m.cms_quick_upload_media_help()}</div>
		</a>
		<a
			href="/cms/categories"
			class="group rounded-lg border border-border bg-card p-4 hover:border-primary hover:bg-muted/40 transition-colors"
		>
			<div class="flex items-center gap-2 text-sm font-medium">
				<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7h18M3 12h18M3 17h18" /></svg>
				{m.cms_quick_taxonomy()}
			</div>
			<div class="text-xs text-muted-foreground mt-1">{m.cms_quick_taxonomy_help()}</div>
		</a>
		<a
			href={data.showActivity ? '/cms/users' : '/cms/articles'}
			class="group rounded-lg border border-border bg-card p-4 hover:border-primary hover:bg-muted/40 transition-colors"
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
									href={`/cms/articles/${a.id}`}
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
					<a href="/cms/articles?status=draft" class="text-xs text-muted-foreground hover:text-foreground">
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
									href={`/cms/articles/${d.id}`}
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
		<Card>
			<CardHeader>
				<CardTitle class="text-sm">{m.cms_dashboard_coverage_title()}</CardTitle>
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

	<!-- Activity -->
	{#if data.showActivity}
		<Card>
			<CardHeader>
				<CardTitle class="text-sm flex items-center justify-between">
					<span>{m.cms_dashboard_activity_title()}</span>
					<a href="/cms/audit" class="text-xs text-muted-foreground hover:text-foreground">
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
