<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { formatDate } from '$lib/utils';
	import { localePath, toLocale } from '$lib/i18n';
	let { data } = $props();
	const locale = $derived.by(() => toLocale(data.locale));

	const activeCategoryName = $derived(
		data.activeCategory
			? (data.activeCategory.localizations[locale]?.name ?? data.activeCategory.slug)
			: null,
	);
	const activeTagName = $derived(
		data.activeTag
			? (data.activeTag.localizations[locale]?.name ?? data.activeTag.slug)
			: null,
	);

	// Resolve article.categoryId → category record for rendering its label.
	const categoriesById = $derived(new Map(data.categories.map((c) => [c.id, c])));
	const tagsById = $derived(new Map(data.tags.map((t) => [t.id, t])));
</script>

<svelte:head>
	<title>{m.blog_title()} — {m.site_name()}</title>
</svelte:head>

<section class="container mx-auto px-4 py-12">
	<h1 class="text-3xl font-bold mb-4">{m.blog_title()}</h1>

	{#if activeCategoryName || activeTagName}
		<div
			class="mb-8 flex items-center justify-between gap-3 flex-wrap border border-border rounded-md px-4 py-2 bg-muted/30"
		>
			<span class="text-sm text-muted-foreground">
				{#if activeCategoryName}
					{m.blog_filter_category()}: <strong class="text-foreground">{activeCategoryName}</strong>
				{:else if activeTagName}
					{m.blog_filter_tag()}: <strong class="text-foreground">{activeTagName}</strong>
				{/if}
			</span>
			<a href={localePath(locale, '/blog')} class="text-sm text-primary hover:underline">
				{m.blog_filter_clear()}
			</a>
		</div>
	{/if}

	{#if data.articles.items.length === 0}
		<p class="text-muted-foreground">{m.blog_no_articles()}</p>
	{:else}
		<div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
			{#each data.articles.items as article (article.id)}
				{@const loc = article.localizations[locale]}
				{@const category = article.categoryId ? categoriesById.get(article.categoryId) : null}
				{@const articleTags = article.tagIds
					.map((id) => tagsById.get(id))
					.filter((t): t is NonNullable<typeof t> => Boolean(t))}
				{#if loc}
					<article
						class="border border-border rounded-lg p-6 hover:shadow-md transition-shadow flex flex-col"
					>
						<a href={localePath(locale, `/blog/${article.slug}`)} class="block flex-1">
							<h2 class="text-xl font-semibold mb-2">{loc.title}</h2>
							{#if loc.excerpt}
								<p class="text-muted-foreground text-sm mb-4">{loc.excerpt}</p>
							{/if}
							<time class="text-xs text-muted-foreground">
								{formatDate(article.publishedAt ?? article.createdAt, locale)}
							</time>
						</a>
						{#if category || articleTags.length}
							<div class="mt-4 flex flex-wrap gap-1.5 text-xs">
								{#if category}
									<a
										href={localePath(locale, `/blog?category=${category.slug}`)}
										class="px-2 py-0.5 rounded border border-border hover:bg-muted"
									>
										{category.localizations[locale]?.name ?? category.slug}
									</a>
								{/if}
								{#each articleTags as tag (tag.id)}
									<a
										href={localePath(locale, `/blog?tag=${tag.slug}`)}
										class="px-2 py-0.5 rounded bg-muted hover:bg-muted/70"
									>
										#{tag.localizations[locale]?.name ?? tag.slug}
									</a>
								{/each}
							</div>
						{/if}
					</article>
				{/if}
			{/each}
		</div>
	{/if}
</section>
