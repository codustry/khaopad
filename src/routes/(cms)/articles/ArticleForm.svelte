<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';
	import type { ArticleRecord } from '$lib/server/content/types';

	type Values = {
		titleEn: string;
		excerptEn: string;
		bodyEn: string;
		titleTh: string;
		excerptTh: string;
		bodyTh: string;
		slugInput: string;
		status: ArticleRecord['status'];
	};

	let {
		existing = null,
		formState = null,
		action = '',
		submitLabel,
	}: {
		existing?: ArticleRecord | null;
		formState?: { error?: string; values?: Partial<Values> } | null;
		action?: string;
		submitLabel: string;
	} = $props();

	// Seed initial values once from (in priority): failed-submit echo → existing record → blanks.
	// These are untracked reads on purpose: we only want to seed on mount, not re-seed on prop changes.
	const initialValues = (): Values => ({
		titleEn: formState?.values?.titleEn ?? existing?.localizations.en?.title ?? '',
		excerptEn: formState?.values?.excerptEn ?? existing?.localizations.en?.excerpt ?? '',
		bodyEn: formState?.values?.bodyEn ?? existing?.localizations.en?.body ?? '',
		titleTh: formState?.values?.titleTh ?? existing?.localizations.th?.title ?? '',
		excerptTh: formState?.values?.excerptTh ?? existing?.localizations.th?.excerpt ?? '',
		bodyTh: formState?.values?.bodyTh ?? existing?.localizations.th?.body ?? '',
		slugInput: formState?.values?.slugInput ?? existing?.slug ?? '',
		status: formState?.values?.status ?? existing?.status ?? 'draft',
	});
	const seed = initialValues();

	let titleEn = $state(seed.titleEn);
	let excerptEn = $state(seed.excerptEn);
	let bodyEn = $state(seed.bodyEn);
	let titleTh = $state(seed.titleTh);
	let excerptTh = $state(seed.excerptTh);
	let bodyTh = $state(seed.bodyTh);
	let slugInput = $state(seed.slugInput);
	let status = $state<ArticleRecord['status']>(seed.status);
	let loading = $state(false);

	// Auto-derive slug preview from English title until the user types their own.
	let slugTouched = $state(Boolean(seed.slugInput));
	const derivedSlug = $derived(slugify(titleEn));
	const displayedSlug = $derived(slugTouched ? slugInput : derivedSlug);

	function onSlugInput(e: Event) {
		slugTouched = true;
		slugInput = (e.target as HTMLInputElement).value;
	}
</script>

<form
	method="POST"
	{action}
	class="space-y-6"
	use:enhance={() => {
		loading = true;
		return async ({ update }) => {
			await update();
			loading = false;
		};
	}}
>
	{#if formState?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
			{formState.error}
		</div>
	{/if}

	<section class="border border-border rounded-lg p-4 space-y-4">
		<header>
			<h2 class="font-semibold">EN</h2>
			<p class="text-xs text-muted-foreground">{m.cms_article_en_required_help()}</p>
		</header>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_title_en()}</span>
			<input
				name="title_en"
				bind:value={titleEn}
				required
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			/>
		</label>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_excerpt()}</span>
			<input
				name="excerpt_en"
				bind:value={excerptEn}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			/>
		</label>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_body()}</span>
			<textarea
				name="body_en"
				bind:value={bodyEn}
				required
				rows={10}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
			></textarea>
		</label>
	</section>

	<section class="border border-border rounded-lg p-4 space-y-4">
		<header>
			<h2 class="font-semibold">TH</h2>
			<p class="text-xs text-muted-foreground">{m.cms_article_th_optional_help()}</p>
		</header>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_title_th()}</span>
			<input
				name="title_th"
				bind:value={titleTh}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			/>
		</label>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_excerpt()}</span>
			<input
				name="excerpt_th"
				bind:value={excerptTh}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			/>
		</label>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_body()}</span>
			<textarea
				name="body_th"
				bind:value={bodyTh}
				rows={10}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
			></textarea>
		</label>
	</section>

	<section class="border border-border rounded-lg p-4 space-y-4">
		<header><h2 class="font-semibold">{m.cms_article_details()}</h2></header>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_slug()}</span>
			<input
				name="slug"
				value={displayedSlug}
				oninput={onSlugInput}
				placeholder={derivedSlug}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
			/>
			<span class="text-xs text-muted-foreground">{m.cms_slug_help()}</span>
		</label>

		<label class="block">
			<span class="text-sm font-medium">{m.col_status()}</span>
			<select
				name="status"
				bind:value={status}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			>
				<option value="draft">{m.status_draft()}</option>
				<option value="published">{m.status_published()}</option>
				<option value="archived">{m.status_archived()}</option>
			</select>
		</label>
	</section>

	<div class="flex items-center justify-between">
		<a href="/articles" class="text-sm text-muted-foreground hover:underline">
			← {m.cms_back_to_list()}
		</a>
		<button
			type="submit"
			disabled={loading}
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
		>
			{loading ? m.cms_saving() : submitLabel}
		</button>
	</div>
</form>
