<script lang="ts">
	import { formatDate } from '$lib/utils';
	let { data } = $props();
</script>

<svelte:head>
	{#if data.seo}
		<title>{data.seo.title}</title>
		<meta name="description" content={data.seo.description} />
	{/if}
</svelte:head>

<article class="container mx-auto px-4 py-12 max-w-3xl">
	<header class="mb-8">
		<h1 class="text-4xl font-bold mb-4">{data.title}</h1>
		<time class="text-sm text-muted-foreground">
			{formatDate(data.publishedAt ?? data.createdAt, data.locale)}
		</time>
	</header>

	<div class="prose prose-lg max-w-none">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: server-rendered markdown from CMS -->
		{@html data.htmlContent}
	</div>
</article>
