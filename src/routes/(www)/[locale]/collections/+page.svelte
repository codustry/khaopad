<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale } from '$lib/i18n';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const locale = $derived(toLocale(data.locale));
</script>

<!-- SEO is rendered by the layout via page.data.seo. -->

<section class="container mx-auto px-4 py-12">
	<h1 class="mb-8 text-3xl font-bold">{m.shop_browse_collections()}</h1>

	{#if data.collections.length === 0}
		<p class="text-muted-foreground">{m.shop_browse_no_collections()}</p>
	{:else}
		<div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
			{#each data.collections as collection (collection.slug)}
				<a
					href={localePath(locale, `/collections/${collection.slug}`)}
					class="group flex flex-col overflow-hidden rounded-lg border border-border transition-shadow hover:shadow-md"
				>
					<div class="aspect-[4/3] bg-muted">
						{#if collection.featuredMediaId}
							<img
								src={`/api/media/${collection.featuredMediaId}`}
								alt={collection.title}
								loading="lazy"
								class="h-full w-full object-cover"
							/>
						{:else}
							<div
								class="flex h-full w-full items-center justify-center text-muted-foreground"
								aria-hidden="true"
							>
								<svg
									class="h-10 w-10 opacity-40"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
								>
									<path d="M4 7h16M4 12h16M4 17h10" />
								</svg>
							</div>
						{/if}
					</div>
					<div class="p-3">
						<h2 class="text-sm font-medium group-hover:underline">{collection.title}</h2>
						<p class="mt-0.5 text-xs text-muted-foreground">
							{m.shop_browse_products_count({ count: String(collection.productCount) })}
						</p>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</section>
