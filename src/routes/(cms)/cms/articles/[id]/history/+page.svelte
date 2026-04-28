<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Avatar, Badge, Card } from '$lib/components/ui';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function formatTimestamp(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}
</script>

<svelte:head>
	<title>{m.cms_history_title()} — {m.cms_app_name()}</title>
</svelte:head>

<section class="mx-auto w-full max-w-4xl">
	<header class="mb-6">
		<a
			href={`/cms/articles/${data.article.id}`}
			class="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
				<path d="M19 12H5M12 19l-7-7 7-7" />
			</svg>
			{m.cms_back_to_list()}
		</a>
		<h1 class="mt-3 text-2xl font-semibold tracking-tight">
			{m.cms_history_title()}
		</h1>
		<p class="mt-1.5 text-sm text-muted-foreground">{m.cms_history_help()}</p>
	</header>

	{#if data.versions.length === 0}
		<Card>
			<div class="p-6 text-sm text-muted-foreground">{m.cms_history_empty()}</div>
		</Card>
	{:else}
		<Card class="overflow-hidden p-0">
			<ul class="divide-y divide-border">
				{#each data.versions as v (v.id)}
					<li class="flex flex-wrap items-center gap-4 p-4 sm:flex-nowrap">
						<Avatar name={v.actor?.name ?? '?'} size="sm" />
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<Badge variant="secondary">v{v.version}</Badge>
								<Badge variant="outline">{v.locale.toUpperCase()}</Badge>
								<span class="text-xs text-muted-foreground">{formatTimestamp(v.createdAt)}</span>
							</div>
							<div class="mt-1 truncate text-sm font-medium text-foreground">{v.title}</div>
							<div class="text-xs text-muted-foreground">
								{v.actor?.name ?? m.cms_history_unknown_actor()}
							</div>
						</div>
						<a
							href={`/cms/articles/${data.article.id}/history/${v.id}`}
							class="text-sm font-medium text-primary underline-offset-4 hover:underline"
						>
							{m.cms_history_view()}
						</a>
					</li>
				{/each}
			</ul>
		</Card>
	{/if}
</section>
