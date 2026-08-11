<script lang="ts">
	/**
	 * Recently-viewed products strip (#160 Phase A, deliverable A6).
	 *
	 * Pure client-side: a localStorage ring buffer under
	 * `khaopad_recently_viewed` (max 8 entries). On product-page mount
	 * the current product is pushed to the front and the strip renders
	 * the REST of the buffer — never the product the visitor is already
	 * looking at.
	 *
	 * SSR-safe by construction: localStorage is only touched inside
	 * onMount, and the section renders nothing until mounted (so server
	 * and first client render agree — no hydration mismatch). Private
	 * browsing / storage-disabled degrades to rendering nothing via
	 * try/catch.
	 *
	 * Titles are captured per-locale at view time, so entries carry the
	 * locale they were captured in and only entries matching the current
	 * page locale are shown — a mixed th/en strip looks broken.
	 */
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import { localePath } from '$lib/i18n';
	import type { Locale } from '$lib/server/content/types';
	import { formatSatang, type Satang } from '$plugins/shop/money';

	export type RecentlyViewedEntry = {
		id: string;
		slug: string;
		title: string;
		/** Price in satang, null when unknown. */
		price: number | null;
		/** Media id for /api/media/<id>, null when the product has no image. */
		image: string | null;
		locale: string;
	};

	const STORAGE_KEY = 'khaopad_recently_viewed';
	const MAX_ENTRIES = 8;

	let {
		current,
		locale,
	}: {
		/** The product being viewed — recorded, never rendered. */
		current: RecentlyViewedEntry;
		locale: Locale;
	} = $props();

	let items = $state<RecentlyViewedEntry[]>([]);

	function isEntry(value: unknown): value is RecentlyViewedEntry {
		if (typeof value !== 'object' || value === null) return false;
		const v = value as Record<string, unknown>;
		return (
			typeof v.id === 'string' &&
			typeof v.slug === 'string' &&
			typeof v.title === 'string' &&
			typeof v.locale === 'string' &&
			(v.price === null || typeof v.price === 'number') &&
			(v.image === null || typeof v.image === 'string')
		);
	}

	onMount(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			const stored = Array.isArray(parsed) ? parsed.filter(isEntry) : [];

			// Render everything except the product we're standing on, and
			// only entries captured in the current locale.
			items = stored
				.filter((e) => e.id !== current.id && e.locale === locale)
				.slice(0, MAX_ENTRIES);

			// Ring buffer write: current product to the front, deduped by
			// id (a th and an en capture of the same product would render
			// as duplicates on a strip that shows one locale at a time).
			const next = [
				current,
				...stored.filter((e) => e.id !== current.id),
			].slice(0, MAX_ENTRIES);
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// localStorage unavailable (private mode, storage disabled) or
			// corrupted JSON — the strip simply doesn't render.
		}
	});
</script>

{#if items.length > 0}
	<section aria-labelledby="recently-viewed-heading" class="mt-12 border-t border-border pt-8">
		<h2
			id="recently-viewed-heading"
			class="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
		>
			{m.shop_recently_viewed_title()}
		</h2>
		<ul class="grid grid-cols-2 gap-4 sm:grid-cols-4">
			{#each items as item (item.id)}
				<li>
					<!-- TODO: swap to shop/ProductCard once merged -->
					<a
						href={localePath(locale, `/products/${item.slug}`)}
						class="block rounded-lg border border-border p-3 transition-colors hover:bg-muted"
					>
						{#if item.image}
							<img
								src={`/api/media/${item.image}`}
								alt=""
								width="160"
								height="160"
								loading="lazy"
								class="mb-2 aspect-square w-full rounded-md border border-border object-cover"
							/>
						{/if}
						<div class="truncate text-sm font-medium">{item.title}</div>
						{#if item.price != null}
							<div class="mt-0.5 text-xs tabular-nums text-muted-foreground">
								{formatSatang(item.price as Satang, locale === 'th' ? 'th' : 'en')}
							</div>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	</section>
{/if}
