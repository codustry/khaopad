<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { formatDate } from '$lib/utils';
	import { Button } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		DataTable,
		TableToolbar,
		StatusBadge,
		type Column
	} from '$lib/components/admin';
	import { FileText } from 'lucide-svelte';
	import type { ArticleRecord } from '$lib/server/content/types';

	type Data = {
		articles: { items: ArticleRecord[] };
		status: ArticleRecord['status'] | null;
		search: string;
	};
	let { data }: { data: Data } = $props();

	const STATUSES: ArticleRecord['status'][] = ['draft', 'published', 'archived'];

	function statusLabel(s: ArticleRecord['status']) {
		if (s === 'published') return m.status_published();
		if (s === 'draft') return m.status_draft();
		return m.status_archived();
	}

	// TableToolbar owns navigation now. The previous handler assigned
	// `window.location.href`, which forced a full document reload on every
	// filter change — discarding the SPA's loaded modules to re-fetch a
	// page SvelteKit could have swapped client-side.
	const filters = [
		{
			param: 'status',
			label: m.cms_filter_status(),
			options: STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))
		}
	];

	const columns: Column<ArticleRecord>[] = [
		{ key: 'title', header: m.col_title(), cell: titleCell },
		{ key: 'status', header: m.col_status(), cell: statusCell },
		{ key: 'languages', header: m.col_languages(), cell: languagesCell },
		{ key: 'updated', header: m.col_updated(), cell: updatedCell },
		{ key: 'actions', header: m.col_actions(), align: 'right', cell: actionsCell }
	];
</script>

{#snippet titleCell(article: ArticleRecord)}
	<a
		href={resolve('/(admin)/admin/articles/[id]', { id: article.id })}
		class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{article.localizations.en?.title ?? article.localizations.th?.title ?? article.slug}
	</a>
	<div class="text-xs text-muted-foreground">{article.slug}</div>
{/snippet}

{#snippet statusCell(article: ArticleRecord)}
	<StatusBadge status={article.status} label={statusLabel(article.status)} />
{/snippet}

{#snippet languagesCell(article: ArticleRecord)}
	<span class="text-muted-foreground">
		{Object.keys(article.localizations).join(', ').toUpperCase()}
	</span>
{/snippet}

{#snippet updatedCell(article: ArticleRecord)}
	<span class="text-muted-foreground">{formatDate(article.updatedAt)}</span>
{/snippet}

{#snippet actionsCell(article: ArticleRecord)}
	<form
		method="POST"
		action="?/delete"
		use:enhance={({ cancel }) => {
			if (!confirm(m.cms_delete_confirm())) {
				cancel();
				return;
			}
			return async ({ update }) => update();
		}}
		class="inline"
	>
		<input type="hidden" name="id" value={article.id} />
		<Button type="submit" variant="ghost" size="sm" class="text-destructive">
			{m.cms_delete()}
		</Button>
	</form>
{/snippet}

<svelte:head>
	<title>{m.cms_articles()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader title={m.cms_articles()} icon={FileText}>
		{#snippet actions()}
			<Button href={resolve('/(admin)/admin/articles/new')}>{m.cms_new_article()}</Button>
		{/snippet}
	</PageHeader>

	<TableToolbar searchPlaceholder={m.cms_search_articles()} {filters} />

	<DataTable columns={columns} rows={data.articles.items} getKey={(a) => a.id}>
		{#snippet empty()}
			<!--
				A search that matches nothing must not read as "you have no
				articles" — that looks like data loss rather than a filter.
			-->
			<p class="text-muted-foreground">
				{data.search || data.status ? m.admin_no_results() : m.cms_no_articles()}
			</p>
		{/snippet}
	</DataTable>
</PageShell>
