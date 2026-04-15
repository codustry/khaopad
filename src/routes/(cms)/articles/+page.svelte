<script lang="ts">
	import { formatDate } from '$lib/utils';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Articles — Khao Pad CMS</title>
</svelte:head>

<div>
	<div class="flex items-center justify-between mb-6">
		<h1 class="text-2xl font-bold">Articles</h1>
		<a
			href="/articles/new"
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
		>
			New Article
		</a>
	</div>

	{#if data.articles.items.length === 0}
		<p class="text-muted-foreground">No articles yet. Create your first one!</p>
	{:else}
		<div class="border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted">
					<tr>
						<th class="text-left px-4 py-3 font-medium">Title</th>
						<th class="text-left px-4 py-3 font-medium">Status</th>
						<th class="text-left px-4 py-3 font-medium">Languages</th>
						<th class="text-left px-4 py-3 font-medium">Updated</th>
					</tr>
				</thead>
				<tbody>
					{#each data.articles.items as article}
						<tr class="border-t border-border hover:bg-muted/50">
							<td class="px-4 py-3">
								<a href="/articles/{article.id}" class="hover:underline font-medium">
									{article.localizations.th?.title ?? article.localizations.en?.title ?? article.slug}
								</a>
							</td>
							<td class="px-4 py-3">
								<span
									class="inline-block px-2 py-0.5 rounded text-xs capitalize"
									class:bg-green-100={article.status === 'published'}
									class:text-green-800={article.status === 'published'}
									class:bg-yellow-100={article.status === 'draft'}
									class:text-yellow-800={article.status === 'draft'}
									class:bg-gray-100={article.status === 'archived'}
									class:text-gray-800={article.status === 'archived'}
								>
									{article.status}
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
