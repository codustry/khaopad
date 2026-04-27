<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { formatDate } from '$lib/utils';
	import type { ArticleRecord } from '$lib/server/content/types';

	type Data = {
		articles: { items: ArticleRecord[] };
		status: ArticleRecord['status'] | null;
	};
	let { data }: { data: Data } = $props();

	const STATUSES: ArticleRecord['status'][] = ['draft', 'published', 'archived'];

	function statusLabel(s: ArticleRecord['status']) {
		if (s === 'published') return m.status_published();
		if (s === 'draft') return m.status_draft();
		return m.status_archived();
	}

	function onStatusChange(e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		const url = new URL(page.url);
		if (value) url.searchParams.set('status', value);
		else url.searchParams.delete('status');
		window.location.href = url.pathname + url.search;
	}
</script>

<svelte:head>
	<title>{m.cms_articles()} — {m.cms_app_name()}</title>
</svelte:head>

<div>
	<div class="flex items-center justify-between mb-6 gap-3 flex-wrap">
		<h1 class="text-2xl font-bold">{m.cms_articles()}</h1>
		<div class="flex items-center gap-3">
			<label class="text-sm flex items-center gap-2">
				<span class="text-muted-foreground">{m.cms_filter_status()}:</span>
				<select
					value={data.status ?? ''}
					onchange={onStatusChange}
					class="px-2 py-1 border border-input rounded-md bg-background text-sm"
				>
					<option value="">{m.cms_filter_all()}</option>
					{#each STATUSES as s (s)}
						<option value={s}>{statusLabel(s)}</option>
					{/each}
				</select>
			</label>
			<a
				href="/cms/articles/new"
				class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
			>
				{m.cms_new_article()}
			</a>
		</div>
	</div>

	{#if data.articles.items.length === 0}
		<p class="text-muted-foreground">{m.cms_no_articles()}</p>
	{:else}
		<div class="border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted">
					<tr>
						<th class="text-left px-4 py-3 font-medium">{m.col_title()}</th>
						<th class="text-left px-4 py-3 font-medium">{m.col_status()}</th>
						<th class="text-left px-4 py-3 font-medium">{m.col_languages()}</th>
						<th class="text-left px-4 py-3 font-medium">{m.col_updated()}</th>
						<th class="text-right px-4 py-3 font-medium">{m.col_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each data.articles.items as article (article.id)}
						<tr class="border-t border-border hover:bg-muted/50">
							<td class="px-4 py-3">
								<a href={`/cms/articles/${article.id}`} class="hover:underline font-medium">
									{article.localizations.en?.title ??
										article.localizations.th?.title ??
										article.slug}
								</a>
								<div class="text-xs text-muted-foreground">{article.slug}</div>
							</td>
							<td class="px-4 py-3">
								<span
									class="inline-block px-2 py-0.5 rounded text-xs"
									class:bg-green-100={article.status === 'published'}
									class:text-green-800={article.status === 'published'}
									class:bg-yellow-100={article.status === 'draft'}
									class:text-yellow-800={article.status === 'draft'}
									class:bg-gray-100={article.status === 'archived'}
									class:text-gray-800={article.status === 'archived'}
								>
									{statusLabel(article.status)}
								</span>
							</td>
							<td class="px-4 py-3 text-muted-foreground">
								{Object.keys(article.localizations).join(', ').toUpperCase()}
							</td>
							<td class="px-4 py-3 text-muted-foreground">
								{formatDate(article.updatedAt)}
							</td>
							<td class="px-4 py-3 text-right">
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
									<button
										type="submit"
										class="text-destructive hover:underline text-xs"
									>
										{m.cms_delete()}
									</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
