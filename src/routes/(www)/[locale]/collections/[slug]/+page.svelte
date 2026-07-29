<script lang="ts">
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<!-- SEO is rendered by the layout via page.data.seo. Only the
     CollectionPage JSON-LD is injected inline. -->

<svelte:head>
	{@html `<script type="application/ld+json">${data.jsonLd}</script>`}
</svelte:head>

<div class="mx-auto max-w-4xl px-6 py-10">
	<header class="mb-8 space-y-2">
		<h1 class="text-3xl font-semibold tracking-tight">
			{data.collection.title}
		</h1>
		{#if data.descriptionHtml}
			<div class="prose prose-sm max-w-none dark:prose-invert">
				{@html data.descriptionHtml}
			</div>
		{/if}
	</header>

	{#if data.products.length === 0}
		<p class="text-sm text-muted-foreground">
			No products in this collection yet.
		</p>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.products as product (product.slug)}
				<li>
					<a
						href="/{data.locale}/products/{product.slug}"
						class="block rounded-lg border border-border p-4 transition-colors hover:bg-muted"
					>
						<div class="font-medium">{product.title}</div>
						{#if product.priceFromSatang != null}
							<div class="mt-1 text-sm tabular-nums text-muted-foreground">
								From {formatSatang(
									product.priceFromSatang as Satang,
									data.locale === 'th' ? 'th' : 'en',
								)}
							</div>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
