<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';
	import type { ArticleRecord, CategoryRecord, TagRecord } from '$lib/server/content/types';
	import MarkdownEditor from '$lib/components/editor/MarkdownEditor.svelte';

	type Values = {
		titleEn: string;
		excerptEn: string;
		bodyEn: string;
		seoTitleEn: string;
		seoDescriptionEn: string;
		titleTh: string;
		excerptTh: string;
		bodyTh: string;
		seoTitleTh: string;
		seoDescriptionTh: string;
		slugInput: string;
		status: ArticleRecord['status'];
		coverMediaId: string;
		categoryId: string;
		tagIds: string[];
		/** "yyyy-MM-ddThh:mm" for the local datetime input; "" means publish immediately */
		publishedAtLocal: string;
	};

	let {
		existing = null,
		formState = null,
		action = '',
		submitLabel,
		categories = [],
		tags = [],
	}: {
		existing?: ArticleRecord | null;
		formState?: { error?: string; values?: Partial<Values> } | null;
		action?: string;
		submitLabel: string;
		categories?: CategoryRecord[];
		tags?: TagRecord[];
	} = $props();

	// Seed initial values once from (in priority): failed-submit echo → existing record → blanks.
	// These are untracked reads on purpose: we only want to seed on mount, not re-seed on prop changes.
	const initialValues = (): Values => ({
		titleEn: formState?.values?.titleEn ?? existing?.localizations.en?.title ?? '',
		excerptEn: formState?.values?.excerptEn ?? existing?.localizations.en?.excerpt ?? '',
		bodyEn: formState?.values?.bodyEn ?? existing?.localizations.en?.body ?? '',
		seoTitleEn: formState?.values?.seoTitleEn ?? existing?.localizations.en?.seoTitle ?? '',
		seoDescriptionEn:
			formState?.values?.seoDescriptionEn ?? existing?.localizations.en?.seoDescription ?? '',
		titleTh: formState?.values?.titleTh ?? existing?.localizations.th?.title ?? '',
		excerptTh: formState?.values?.excerptTh ?? existing?.localizations.th?.excerpt ?? '',
		bodyTh: formState?.values?.bodyTh ?? existing?.localizations.th?.body ?? '',
		seoTitleTh: formState?.values?.seoTitleTh ?? existing?.localizations.th?.seoTitle ?? '',
		seoDescriptionTh:
			formState?.values?.seoDescriptionTh ?? existing?.localizations.th?.seoDescription ?? '',
		slugInput: formState?.values?.slugInput ?? existing?.slug ?? '',
		status: formState?.values?.status ?? existing?.status ?? 'draft',
		coverMediaId: formState?.values?.coverMediaId ?? existing?.coverMediaId ?? '',
		categoryId: formState?.values?.categoryId ?? existing?.categoryId ?? '',
		tagIds: formState?.values?.tagIds ?? existing?.tagIds ?? [],
		publishedAtLocal:
			formState?.values?.publishedAtLocal ?? isoToLocalInput(existing?.publishedAt) ?? '',
	});

	/**
	 * Convert an ISO timestamp string into the format `<input type="datetime-local">`
	 * accepts (`YYYY-MM-DDTHH:mm`). Returns `null` for missing input. The browser
	 * will then re-emit it back to us as the same shape on submit.
	 */
	function isoToLocalInput(iso: string | null | undefined): string | null {
		if (!iso) return null;
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return null;
		const pad = (n: number) => n.toString().padStart(2, '0');
		return (
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
			`T${pad(d.getHours())}:${pad(d.getMinutes())}`
		);
	}
	const seed = initialValues();

	let titleEn = $state(seed.titleEn);
	let excerptEn = $state(seed.excerptEn);
	let bodyEn = $state(seed.bodyEn);
	let seoTitleEn = $state(seed.seoTitleEn);
	let seoDescriptionEn = $state(seed.seoDescriptionEn);
	let titleTh = $state(seed.titleTh);
	let excerptTh = $state(seed.excerptTh);
	let bodyTh = $state(seed.bodyTh);
	let seoTitleTh = $state(seed.seoTitleTh);
	let seoDescriptionTh = $state(seed.seoDescriptionTh);
	let slugInput = $state(seed.slugInput);
	let status = $state<ArticleRecord['status']>(seed.status);
	let coverMediaId = $state(seed.coverMediaId);
	let categoryId = $state(seed.categoryId);
	let tagIds = $state<string[]>(seed.tagIds);
	let publishedAtLocal = $state(seed.publishedAtLocal);
	let loading = $state(false);

	// "Scheduled" means: status is published AND publishedAt is in the future.
	// Surface a small chip so the editor knows the article won't go live yet.
	const scheduledNotice = $derived.by(() => {
		if (status !== 'published' || !publishedAtLocal) return null;
		const t = new Date(publishedAtLocal).getTime();
		if (Number.isNaN(t) || t <= Date.now()) return null;
		return new Date(publishedAtLocal).toLocaleString();
	});

	// Auto-derive slug preview from English title until the user types their own.
	let slugTouched = $state(Boolean(seed.slugInput));
	const derivedSlug = $derived(slugify(titleEn));
	const displayedSlug = $derived(slugTouched ? slugInput : derivedSlug);

	function onSlugInput(e: Event) {
		slugTouched = true;
		slugInput = (e.target as HTMLInputElement).value;
	}

	/**
	 * Soft SEO scoring per locale. Advisory only — never blocks save.
	 * Title sweet spot: 30–60 chars (Google truncates around 60).
	 * Description sweet spot: 70–160 chars.
	 * Returns one of "good" | "warn" | "empty" so the UI can color-code.
	 */
	type SeoVerdict = { tone: 'good' | 'warn' | 'empty'; message: string };
	function scoreTitle(value: string, fallback: string): SeoVerdict {
		const v = value || fallback;
		if (!v) return { tone: 'empty', message: m.cms_seo_title_empty() };
		const len = v.length;
		if (len < 30) return { tone: 'warn', message: m.cms_seo_title_short({ len: String(len) }) };
		if (len > 60) return { tone: 'warn', message: m.cms_seo_title_long({ len: String(len) }) };
		return { tone: 'good', message: m.cms_seo_title_good({ len: String(len) }) };
	}
	function scoreDescription(value: string, fallback: string): SeoVerdict {
		const v = value || fallback;
		if (!v) return { tone: 'empty', message: m.cms_seo_description_empty() };
		const len = v.length;
		if (len < 70)
			return { tone: 'warn', message: m.cms_seo_description_short({ len: String(len) }) };
		if (len > 160)
			return { tone: 'warn', message: m.cms_seo_description_long({ len: String(len) }) };
		return { tone: 'good', message: m.cms_seo_description_good({ len: String(len) }) };
	}
	const seoTitleEnScore = $derived(scoreTitle(seoTitleEn, titleEn));
	const seoDescEnScore = $derived(scoreDescription(seoDescriptionEn, excerptEn));
	const seoTitleThScore = $derived(scoreTitle(seoTitleTh, titleTh));
	const seoDescThScore = $derived(scoreDescription(seoDescriptionTh, excerptTh));

	function verdictClass(v: SeoVerdict): string {
		if (v.tone === 'good') return 'text-emerald-700';
		if (v.tone === 'warn') return 'text-amber-700';
		return 'text-muted-foreground';
	}

	// Autosave draft keys — scope per article ("new" for unsaved, id for existing).
	// On successful save we'll call the editor's `clearDraft()` so recovery
	// prompts don't reappear after the round-trip.
	const draftScope = $derived(existing?.id ?? 'new');
	let editorEn = $state<{ clearDraft: () => void } | null>(null);
	let editorTh = $state<{ clearDraft: () => void } | null>(null);
</script>

<form
	method="POST"
	{action}
	class="space-y-6"
	use:enhance={() => {
		loading = true;
		return async ({ update, result }) => {
			await update();
			loading = false;
			// On a successful save, clear the localStorage drafts so the
			// recovery banner doesn't reappear with stale content.
			if (result.type === 'success' || result.type === 'redirect') {
				editorEn?.clearDraft();
				editorTh?.clearDraft();
			}
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

		<div class="block">
			<span class="text-sm font-medium">{m.cms_body()}</span>
			<div class="mt-1">
				<MarkdownEditor
					bind:this={editorEn}
					bind:value={bodyEn}
					name="body_en"
					required
					rows={14}
					draftKey={`article:${draftScope}:body_en`}
				/>
			</div>
		</div>

		<details class="rounded-md border border-border bg-muted/20" open>
			<summary class="cursor-pointer px-3 py-2 text-sm font-medium">
				{m.cms_seo_section()}
			</summary>
			<div class="space-y-3 p-3 pt-2">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_title_label()}</span>
					<input
						name="seo_title_en"
						bind:value={seoTitleEn}
						placeholder={titleEn}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
					<span class="text-xs {verdictClass(seoTitleEnScore)}">{seoTitleEnScore.message}</span>
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_description_label()}</span>
					<textarea
						name="seo_description_en"
						bind:value={seoDescriptionEn}
						rows="2"
						placeholder={excerptEn}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					></textarea>
					<span class="text-xs {verdictClass(seoDescEnScore)}">{seoDescEnScore.message}</span>
				</label>
			</div>
		</details>
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

		<div class="block">
			<span class="text-sm font-medium">{m.cms_body()}</span>
			<div class="mt-1">
				<MarkdownEditor
					bind:this={editorTh}
					bind:value={bodyTh}
					name="body_th"
					rows={14}
					draftKey={`article:${draftScope}:body_th`}
				/>
			</div>
		</div>

		<details class="rounded-md border border-border bg-muted/20">
			<summary class="cursor-pointer px-3 py-2 text-sm font-medium">
				{m.cms_seo_section()}
			</summary>
			<div class="space-y-3 p-3 pt-2">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_title_label()}</span>
					<input
						name="seo_title_th"
						bind:value={seoTitleTh}
						placeholder={titleTh}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
					<span class="text-xs {verdictClass(seoTitleThScore)}">{seoTitleThScore.message}</span>
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_description_label()}</span>
					<textarea
						name="seo_description_th"
						bind:value={seoDescriptionTh}
						rows="2"
						placeholder={excerptTh}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					></textarea>
					<span class="text-xs {verdictClass(seoDescThScore)}">{seoDescThScore.message}</span>
				</label>
			</div>
		</details>
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

		<label class="block">
			<span class="text-sm font-medium">{m.cms_published_at()}</span>
			<input
				type="datetime-local"
				name="published_at_local"
				bind:value={publishedAtLocal}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			/>
			<span class="text-xs text-muted-foreground">{m.cms_published_at_help()}</span>
			{#if scheduledNotice}
				<span class="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
					⏱ {m.cms_scheduled_for({ when: scheduledNotice })}
				</span>
			{/if}
		</label>

		<div class="block">
			<span class="text-sm font-medium">{m.cms_cover_media()}</span>
			<div class="mt-1 flex items-start gap-3">
				{#if coverMediaId}
					<img
						src={`/api/media/${coverMediaId}`}
						alt=""
						class="h-20 w-20 object-cover rounded-md border border-border"
						onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
					/>
				{:else}
					<div
						class="h-20 w-20 rounded-md border border-dashed border-border flex items-center justify-center text-[10px] text-muted-foreground text-center p-1"
					>
						{m.cms_cover_media_none()}
					</div>
				{/if}
				<div class="flex-1 space-y-1">
					<input
						name="cover_media_id"
						bind:value={coverMediaId}
						placeholder="media-id"
						class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
					/>
					<div class="flex items-center justify-between text-xs">
						<span class="text-muted-foreground">{m.cms_cover_media_help()}</span>
						{#if coverMediaId}
							<button
								type="button"
								class="text-destructive hover:underline"
								onclick={() => (coverMediaId = '')}
							>
								{m.cms_cover_media_clear()}
							</button>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<label class="block">
			<span class="text-sm font-medium">{m.cms_article_category()}</span>
			<select
				name="category_id"
				bind:value={categoryId}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			>
				<option value="">{m.cms_article_category_none()}</option>
				{#each categories as cat (cat.id)}
					<option value={cat.id}>
						{cat.localizations.en?.name ?? cat.slug}
					</option>
				{/each}
			</select>
		</label>

		<div class="block">
			<span class="text-sm font-medium">{m.cms_article_tags()}</span>
			{#if tags.length === 0}
				<p class="mt-1 text-xs text-muted-foreground">{m.cms_article_tags_none()}</p>
			{:else}
				<div class="mt-1 flex flex-wrap gap-2">
					{#each tags as tag (tag.id)}
						<label
							class="inline-flex items-center gap-1.5 px-2 py-1 border border-input rounded-md text-sm cursor-pointer hover:bg-accent"
						>
							<input
								type="checkbox"
								name="tag_ids"
								value={tag.id}
								bind:group={tagIds}
								class="h-3.5 w-3.5"
							/>
							<span>{tag.localizations.en?.name ?? tag.slug}</span>
						</label>
					{/each}
				</div>
			{/if}
		</div>
	</section>

	<div class="flex items-center justify-between">
		<a href="/cms/articles" class="text-sm text-muted-foreground hover:underline">
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
