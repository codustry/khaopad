<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { cmsHref } from '$lib/cms-href';
	import { formatDate } from '$lib/utils';
	let { data } = $props();
</script>

<svelte:head>
	<title>{m.cms_articles()} — {m.cms_app_name()}</title>
</svelte:head>

<div>
	<div class="flex items-center justify-between mb-6">
		<h1 class="text-2xl font-bold">{m.cms_articles()}</h1>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved in $lib/cms-href -->
		<a href={cmsHref.articlesNew} class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90">
			{m.cms_new_article()}
		</a>
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
					</tr>
				</thead>
				<tbody>
					{#each data.articles.items as article (article.id)}
						<tr class="border-t border-border hover:bg-muted/50">
							<td class="px-4 py-3">
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved in $lib/cms-href -->
								<a href={cmsHref.article(article.id)} class="hover:underline font-medium">
									{article.localizations.th?.title ?? article.localizations.en?.title ?? article.slug}
								</a>
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
									{article.status === 'published' ? m.status_published() : article.status === 'draft' ? m.status_draft() : m.status_archived()}
								</span>
							</td>
							<td class="px-4 py-3 text-muted-foreground">
								{Object.keys(article.localizations).join(', ').toUpperCase()}
							</td>
							<td class="px-4 py-3 text-muted-foreground">
								{formatDate(article.updatedAt)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
