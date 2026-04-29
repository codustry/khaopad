<script lang="ts">
	import { formatDate } from '$lib/utils';
	let { data } = $props();
</script>

<!-- SEO is handled by the layout's <Seo /> component (full meta + Article JSON-LD). -->

<article class="container mx-auto px-4 py-12 max-w-3xl">
	<header class="mb-8">
		{#if data.coverMediaId}
			<img
				src={`/api/media/${data.coverMediaId}`}
				alt=""
				class="w-full h-auto mb-6 rounded-lg object-cover aspect-[16/9]"
			/>
		{/if}
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
