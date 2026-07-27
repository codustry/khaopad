<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Avatar, Badge, Button, Card } from '$lib/components/ui';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function formatTimestamp(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	function actionVariant(action: string) {
		if (action.endsWith('.delete') || action.endsWith('.revoke')) return 'destructive';
		if (action.endsWith('.create') || action.endsWith('.accept')) return 'default';
		return 'secondary';
	}
</script>

<svelte:head>
	<title>{m.cms_audit_log()} — {m.cms_app_name()}</title>
</svelte:head>

<section class="mx-auto w-full max-w-5xl">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">{m.cms_audit_log()}</h1>
		<p class="mt-1.5 text-sm text-muted-foreground">{m.cms_audit_help()}</p>
	</header>

	{#if data.items.length === 0}
		<Card>
			<div class="p-6 text-sm text-muted-foreground">{m.cms_audit_empty()}</div>
		</Card>
	{:else}
		<Card class="overflow-hidden p-0">
			<ul class="divide-y divide-border">
				{#each data.items as row (row.id)}
					<li class="flex flex-wrap items-start gap-4 p-4 sm:flex-nowrap">
						<Avatar name={row.actorName ?? '?'} size="sm" />

						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<Badge variant={actionVariant(row.action)}>{row.action}</Badge>
								<span class="text-xs text-muted-foreground">
									{formatTimestamp(row.createdAt)}
								</span>
							</div>
							<div class="mt-1 text-sm">
								<span class="font-medium text-foreground">
									{row.actorName ?? m.cms_audit_unknown_actor()}
								</span>
								{#if row.actorEmail}
									<span class="text-muted-foreground"> · {row.actorEmail}</span>
								{/if}
							</div>
							<div class="mt-0.5 text-xs text-muted-foreground">
								{row.entityType} · {row.entityId}
							</div>
							{#if row.metadata && typeof row.metadata === 'object' && Object.keys(row.metadata).length > 0}
								<pre
									class="mt-2 overflow-x-auto rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono text-muted-foreground">{JSON.stringify(
										row.metadata,
										null,
										2,
									)}</pre>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</Card>

		<nav class="mt-6 flex items-center justify-between text-sm">
			<div class="text-muted-foreground">
				{m.cms_audit_page({ page: String(data.page) })}
			</div>
			<div class="flex gap-2">
				{#if data.hasPrev}
					<Button href={`?page=${data.page - 1}`} variant="outline" size="sm">
						{m.cms_audit_prev()}
					</Button>
				{/if}
				{#if data.hasNext}
					<Button href={`?page=${data.page + 1}`} variant="outline" size="sm">
						{m.cms_audit_next()}
					</Button>
				{/if}
			</div>
		</nav>
	{/if}
</section>
