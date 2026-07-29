<script lang="ts">
	import { formatDate } from '$lib/utils';
	import ResponsiveImage from '$lib/components/media/ResponsiveImage.svelte';
	import CommentSection from '$lib/components/comments/CommentSection.svelte';
	import ArticleReadTracker from '$lib/analytics/ArticleReadTracker.svelte';
	let { data } = $props();
</script>

{#if data.articleId}
	<ArticleReadTracker articleId={data.articleId} />
{/if}

<!-- SEO is handled by the layout's <Seo /> component (full meta + Article JSON-LD). -->

<article class="container mx-auto px-4 py-12 max-w-3xl">
	<header class="mb-8">
		{#if data.coverMediaId}
			<ResponsiveImage
				src={`/api/media/${data.coverMediaId}`}
				alt=""
				class="w-full h-auto mb-6 rounded-lg object-cover"
				aspect="aspect-[16/9]"
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

	{#if data.relatedProducts && data.relatedProducts.length > 0}
		<!-- v3.4 federation: "Related products" section powered by
			shop_article_product_refs. Featured refs get a distinct
			treatment; mentioned refs are a simple list. -->
		<section class="mt-12 border-t border-border pt-8">
			<h2 class="mb-4 text-lg font-semibold">Related products</h2>
			<ul class="grid gap-3 sm:grid-cols-2">
				{#each data.relatedProducts as ref (ref.productId)}
					{#if ref.product}
						<li>
							<a
								href="/{data.locale}/products/{ref.product.slug}"
								class="block rounded-lg border p-4 transition-colors hover:bg-muted {ref.refKind ===
								'featured'
									? 'border-primary bg-primary/5'
									: 'border-border'}"
							>
								<div class="font-medium">{ref.product.title}</div>
								{#if ref.product.priceFromSatang != null}
									<div class="mt-1 text-sm text-muted-foreground tabular-nums">
										From ฿{(ref.product.priceFromSatang / 100).toFixed(2)}
									</div>
								{/if}
							</a>
						</li>
					{/if}
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.commentsOpen || data.comments.length > 0}
		<CommentSection
			articleId={data.articleId}
			comments={data.comments}
			open={data.commentsOpen}
		/>
	{/if}
</article>
