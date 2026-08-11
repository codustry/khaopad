<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { localePath } from '$lib/i18n';
	import type { Locale } from '$lib/server/content/types';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import { browseTitle, type BrowseProduct } from './browse';

	let { product, locale }: { product: BrowseProduct; locale: Locale } = $props();

	const title = $derived(browseTitle(product, locale));
	const moneyLocale = $derived(locale === 'th' ? 'th' : 'en');
</script>

<a
	href={localePath(locale, `/products/${product.slug}`)}
	class="group flex flex-col overflow-hidden rounded-lg border border-border transition-shadow hover:shadow-md"
>
	<div class="relative aspect-square bg-muted">
		{#if product.featuredMediaId}
			<!-- Same media URL convention as the cart thumbnails (#152). -->
			<img
				src={`/api/media/${product.featuredMediaId}`}
				alt={title}
				loading="lazy"
				class="h-full w-full object-cover"
			/>
		{:else}
			<div class="flex h-full w-full items-center justify-center text-muted-foreground" aria-hidden="true">
				<svg class="h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<rect x="3" y="3" width="18" height="18" rx="2" />
					<circle cx="9" cy="9" r="2" />
					<path d="m21 15-3.5-3.5L6 23" />
				</svg>
			</div>
		{/if}
		{#if !product.inStock}
			<span
				class="absolute left-2 top-2 rounded bg-background/90 px-2 py-0.5 text-xs font-medium text-destructive"
			>
				{m.shop_browse_sold_out()}
			</span>
		{/if}
	</div>
	<div class="flex flex-1 flex-col gap-1 p-3">
		<h3 class="text-sm font-medium leading-snug group-hover:underline">{title}</h3>
		{#if product.vendor}
			<p class="text-xs text-muted-foreground">{product.vendor}</p>
		{/if}
		{#if product.priceMinSatang != null}
			<p class="mt-auto pt-1 text-sm tabular-nums">
				{#if product.priceMaxSatang != null && product.priceMaxSatang > product.priceMinSatang}
					{m.shop_browse_from_price({
						price: formatSatang(product.priceMinSatang as Satang, moneyLocale)
					})}
				{:else}
					{formatSatang(product.priceMinSatang as Satang, moneyLocale)}
				{/if}
			</p>
		{/if}
	</div>
</a>
