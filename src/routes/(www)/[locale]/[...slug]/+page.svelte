<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Three soft templates. The wrapper class shifts max-width / padding
	// to match the page's intent. Default = article-like; landing = wide;
	// legal = narrow + tight typography for dense regulatory text.
	const wrapperClass = $derived(
		data.template === 'landing'
			? 'mx-auto px-4 py-16'
			: data.template === 'legal'
				? 'container mx-auto px-4 py-12 max-w-2xl text-sm leading-relaxed'
				: 'container mx-auto px-4 py-12 max-w-3xl',
	);
</script>

<!-- SEO is handled by the layout's <Seo /> component (full meta + alternates). -->

<article class={wrapperClass}>
	<header class="mb-8">
		<h1 class="text-4xl font-bold mb-2">{data.title}</h1>
	</header>
	<div class="prose prose-neutral dark:prose-invert max-w-none">
		{@html data.htmlContent}
	</div>
</article>
