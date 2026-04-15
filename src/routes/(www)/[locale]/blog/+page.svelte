<script lang="ts">
	import { formatDate } from '$lib/utils';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Blog — Khao Pad</title>
</svelte:head>

<section class="container mx-auto px-4 py-12">
	<h1 class="text-3xl font-bold mb-8">Blog</h1>

	{#if data.articles.items.length === 0}
		<p class="text-muted-foreground">No articles yet.</p>
	{:else}
		<div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
			{#each data.articles.items as article}
				{@const loc = article.localizations[data.locale]}
				{#if loc}
					<a
						href="/{data.locale}/blog/{article.slug}"
						class="block border border-border rounded-lg p-6 hover:shadow-md transition-shadow"
					>
						<h2 class="text-xl font-semibold mb-2">{loc.title}</h2>
						{#if loc.excerpt}
							<p class="text-muted-foreground text-sm mb-4">{loc.excerpt}</p>
						{/if}
						<time class="text-xs text-muted-foreground">
							{formatDate(article.publishedAt ?? article.createdAt, data.locale)}
						</time>
					</a>
				{/if}
			{/each}
		</div>
	{/if}
</section>
