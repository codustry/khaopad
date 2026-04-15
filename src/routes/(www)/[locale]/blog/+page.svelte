<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { formatDate } from '$lib/utils';
	import { toLocale } from '$lib/i18n';
	import { resolve } from '$app/paths';
	let { data } = $props();
	const locale = $derived.by(() => toLocale(data.locale));
</script>

<svelte:head>
	<title>{m.blog_title()} — {m.site_name()}</title>
</svelte:head>

<section class="container mx-auto px-4 py-12">
	<h1 class="text-3xl font-bold mb-8">{m.blog_title()}</h1>

	{#if data.articles.items.length === 0}
		<p class="text-muted-foreground">{m.blog_no_articles()}</p>
	{:else}
		<div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
			{#each data.articles.items as article (article.id)}
				{@const loc = article.localizations[locale]}
				{#if loc}
					<a
						href={resolve('/(www)/[locale]/blog/[slug]', { locale, slug: article.slug })}
						class="block border border-border rounded-lg p-6 hover:shadow-md transition-shadow"
					>
						<h2 class="text-xl font-semibold mb-2">{loc.title}</h2>
						{#if loc.excerpt}
							<p class="text-muted-foreground text-sm mb-4">{loc.excerpt}</p>
						{/if}
						<time class="text-xs text-muted-foreground">
							{formatDate(article.publishedAt ?? article.createdAt, locale)}
						</time>
					</a>
				{/if}
			{/each}
		</div>
	{/if}
</section>
