<script lang="ts">
	/**
	 * Storefront reviews block (#160 D2) — owned by @khaopad/plugin-reviews.
	 *
	 * Approved reviews only (the server load filters). The submission
	 * form posts multipart form-data to /api/reviews with the shared
	 * honeypot field; on success it shows the pending-moderation notice
	 * rather than optimistically inserting the review (it is not public
	 * yet, so showing it would lie).
	 */
	import * as m from '$lib/paraglide/messages';
	import { HONEYPOT_FIELD } from '$lib/forms/constants';
	import type { Locale } from '$lib/server/content/types';

	type ReviewItem = {
		id: string;
		rating: number;
		title: string;
		body: string;
		verified: boolean;
		createdAt: string;
		author: string;
	};

	let {
		locale,
		productId,
		average,
		count,
		items
	}: {
		locale: Locale;
		productId: string;
		average: number | null;
		count: number;
		items: ReviewItem[];
	} = $props();

	// ─── Relative dates ─────────────────────────────────────────
	// Intl.RelativeTimeFormat speaks Thai natively — no message keys
	// needed for "3 days ago" / "3 วันที่แล้ว".
	const rtf = new Intl.RelativeTimeFormat(locale === 'th' ? 'th' : 'en', {
		numeric: 'auto'
	});
	function relativeDate(iso: string): string {
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return iso;
		const diffSec = Math.round((then - Date.now()) / 1000);
		const table: Array<[Intl.RelativeTimeFormatUnit, number]> = [
			['year', 31536000],
			['month', 2592000],
			['week', 604800],
			['day', 86400],
			['hour', 3600],
			['minute', 60]
		];
		for (const [unit, sec] of table) {
			if (Math.abs(diffSec) >= sec) return rtf.format(Math.trunc(diffSec / sec), unit);
		}
		return rtf.format(diffSec, 'second');
	}

	function stars(rating: number): string {
		return '★'.repeat(rating) + '☆'.repeat(5 - rating);
	}

	// ─── Submission form ────────────────────────────────────────
	let rating = $state(5);
	let title = $state('');
	let body = $state('');
	let email = $state('');
	let orderNumber = $state('');
	let submitting = $state(false);
	let submitted = $state(false);
	let submitError = $state<string | null>(null);

	async function submitReview(e: SubmitEvent) {
		e.preventDefault();
		if (submitting) return;
		submitting = true;
		submitError = null;
		try {
			const fd = new FormData(e.currentTarget as HTMLFormElement);
			const res = await fetch('/api/reviews', { method: 'POST', body: fd });
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { message?: string } | null;
				submitError = data?.message ?? m.shop_reviews_error();
				return;
			}
			submitted = true;
		} catch {
			submitError = m.shop_reviews_error();
		} finally {
			submitting = false;
		}
	}
</script>

<section aria-labelledby="reviews-heading" class="mt-12 border-t border-border pt-8">
	<h2
		id="reviews-heading"
		class="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
	>
		{m.shop_reviews_title()}
	</h2>

	{#if count > 0 && average != null}
		<div class="mb-6 flex items-baseline gap-3">
			<span class="text-2xl font-semibold tabular-nums">{average.toFixed(1)}</span>
			<span class="text-amber-500" aria-label={m.shop_reviews_stars_aria({ rating: String(Math.round(average)) })}>
				{stars(Math.round(average))}
			</span>
			<span class="text-sm text-muted-foreground">
				{m.shop_reviews_count({ count: String(count) })}
			</span>
		</div>

		<ul class="space-y-4">
			{#each items as review (review.id)}
				<li class="rounded-lg border border-border p-4">
					<div class="mb-1 flex flex-wrap items-center gap-2">
						<span
							class="text-sm text-amber-500"
							aria-label={m.shop_reviews_stars_aria({ rating: String(review.rating) })}
						>
							{stars(review.rating)}
						</span>
						<span class="text-sm font-medium">{review.title}</span>
						{#if review.verified}
							<span
								class="rounded-full border border-green-600/30 bg-green-600/10 px-2 py-0.5 text-xs text-green-700 dark:text-green-400"
							>
								{m.shop_reviews_verified()}
							</span>
						{/if}
					</div>
					<p class="whitespace-pre-wrap text-sm text-foreground">{review.body}</p>
					<p class="mt-2 text-xs text-muted-foreground">
						{review.author} · {relativeDate(review.createdAt)}
					</p>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">{m.shop_reviews_empty()}</p>
	{/if}

	<!-- ─── Submission form ─────────────────────────────────── -->
	<div class="mt-8">
		{#if submitted}
			<p class="rounded-md border border-green-600/30 bg-green-600/10 px-3 py-2.5 text-sm">
				{m.shop_reviews_submitted()}
			</p>
		{:else}
			<h3 class="mb-3 text-sm font-semibold">{m.shop_reviews_write()}</h3>
			<form class="space-y-4" onsubmit={submitReview}>
				<input type="hidden" name="product_id" value={productId} />
				<input type="hidden" name="locale" value={locale} />
				<!-- Honeypot — visually hidden; bots fill it, humans never see it. -->
				<div class="hidden" aria-hidden="true">
					<label>
						Leave this field empty
						<input type="text" name={HONEYPOT_FIELD} tabindex="-1" autocomplete="off" />
					</label>
				</div>

				<fieldset>
					<legend class="mb-1 block text-sm font-medium">{m.shop_reviews_rating_label()}</legend>
					<div class="flex gap-1" role="radiogroup" aria-label={m.shop_reviews_rating_label()}>
						{#each [1, 2, 3, 4, 5] as value (value)}
							<label class="cursor-pointer">
								<input
									type="radio"
									name="rating"
									{value}
									bind:group={rating}
									class="sr-only"
								/>
								<span
									class="text-2xl {value <= rating ? 'text-amber-500' : 'text-muted-foreground/40'}"
									aria-hidden="true">★</span
								>
								<span class="sr-only">{m.shop_reviews_stars_aria({ rating: String(value) })}</span>
							</label>
						{/each}
					</div>
				</fieldset>

				<div class="grid gap-4 sm:grid-cols-2">
					<label class="block text-sm">
						<span class="mb-1 block font-medium">{m.shop_reviews_form_email()}</span>
						<input
							type="email"
							name="email"
							bind:value={email}
							required
							class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
						/>
					</label>
					<label class="block text-sm">
						<span class="mb-1 block font-medium">{m.shop_reviews_form_order()}</span>
						<input
							type="text"
							name="order_number"
							bind:value={orderNumber}
							class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
						/>
						<span class="mt-1 block text-xs text-muted-foreground">
							{m.shop_reviews_form_order_help()}
						</span>
					</label>
				</div>

				<label class="block text-sm">
					<span class="mb-1 block font-medium">{m.shop_reviews_form_title()}</span>
					<input
						type="text"
						name="title"
						bind:value={title}
						required
						maxlength="150"
						class="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
					/>
				</label>

				<label class="block text-sm">
					<span class="mb-1 block font-medium">{m.shop_reviews_form_body()}</span>
					<textarea
						name="body"
						bind:value={body}
						required
						maxlength="4000"
						rows="4"
						class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
					></textarea>
				</label>

				{#if submitError}
					<p class="text-sm text-destructive">{submitError}</p>
				{/if}

				<button
					type="submit"
					disabled={submitting}
					class="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50"
				>
					{submitting ? m.shop_reviews_submitting() : m.shop_reviews_submit()}
				</button>
			</form>
		{/if}
	</div>
</section>
