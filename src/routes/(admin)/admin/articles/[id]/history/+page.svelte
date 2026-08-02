<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { History } from 'lucide-svelte';
	import { Avatar, Badge, Button } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, type Column } from '$lib/components/admin';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Version = PageData['versions'][number];

	// ArticleRecord carries no top-level title; the crumb label comes from the
	// English localization, falling back to the slug.
	const articleTitle = $derived(data.article.localizations.en?.title ?? data.article.slug);

	function formatTimestamp(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	const columns: Column<Version>[] = [
		{ key: 'version', header: '', cell: versionCell },
		{ key: 'title', header: m.cms_history_title(), cell: titleCell },
		{ key: 'actor', header: '', cell: actorCell, class: 'hidden sm:table-cell' },
		{ key: 'actions', header: '', align: 'right', cell: actionsCell },
	];
</script>

{#snippet versionCell(v: Version)}
	<div class="flex flex-wrap items-center gap-1.5">
		<Badge variant="secondary">v{v.version}</Badge>
		<Badge variant="outline">{v.locale.toUpperCase()}</Badge>
	</div>
{/snippet}

{#snippet titleCell(v: Version)}
	<div class="min-w-0">
		<div class="truncate font-medium text-foreground">{v.title}</div>
		<div class="text-xs text-muted-foreground">{formatTimestamp(v.createdAt)}</div>
	</div>
{/snippet}

{#snippet actorCell(v: Version)}
	<div class="flex items-center gap-2">
		<Avatar name={v.actor?.name ?? '?'} size="sm" />
		<span class="truncate text-xs text-muted-foreground">
			{v.actor?.name ?? m.cms_history_unknown_actor()}
		</span>
	</div>
{/snippet}

{#snippet actionsCell(v: Version)}
	<Button
		variant="ghost"
		size="sm"
		href={resolve('/(admin)/admin/articles/[id]/history/[versionId]', {
			id: data.article.id,
			versionId: v.id,
		})}
	>
		{m.cms_history_view()}
	</Button>
{/snippet}

<svelte:head>
	<title>{m.cms_history_title()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader
		title={m.cms_history_title()}
		description={m.cms_history_help()}
		icon={History}
		breadcrumbs={[
			{ label: 'Articles', href: resolve('/(admin)/admin/articles') },
			{
				label: articleTitle,
				href: resolve('/(admin)/admin/articles/[id]', { id: data.article.id }),
			},
			{ label: m.cms_history_title() },
		]}
	/>

	<DataTable
		columns={columns}
		rows={data.versions}
		getKey={(v) => v.id}
		caption={m.cms_history_title()}
	>
		{#snippet empty()}
			<p class="text-sm text-muted-foreground">{m.cms_history_empty()}</p>
		{/snippet}
	</DataTable>
</PageShell>
