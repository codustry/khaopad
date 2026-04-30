<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';
	import MarkdownEditor from '$lib/components/editor/MarkdownEditor.svelte';
	import type { PageRecord } from '$lib/server/content/types';

	type Values = {
		titleEn: string;
		bodyEn: string;
		seoTitleEn: string;
		seoDescriptionEn: string;
		titleTh: string;
		bodyTh: string;
		seoTitleTh: string;
		seoDescriptionTh: string;
		slugInput: string;
		template: PageRecord['template'];
		status: PageRecord['status'];
		publishedAtLocal: string;
	};

	let {
		existing = null,
		formState = null,
		action = '',
		submitLabel,
	}: {
		existing?: PageRecord | null;
		formState?: { error?: string; values?: Partial<Values> } | null;
		action?: string;
		submitLabel: string;
	} = $props();

	const initial = (): Values => ({
		titleEn: formState?.values?.titleEn ?? existing?.localizations.en?.title ?? '',
		bodyEn: formState?.values?.bodyEn ?? existing?.localizations.en?.body ?? '',
		seoTitleEn: formState?.values?.seoTitleEn ?? existing?.localizations.en?.seoTitle ?? '',
		seoDescriptionEn:
			formState?.values?.seoDescriptionEn ?? existing?.localizations.en?.seoDescription ?? '',
		titleTh: formState?.values?.titleTh ?? existing?.localizations.th?.title ?? '',
		bodyTh: formState?.values?.bodyTh ?? existing?.localizations.th?.body ?? '',
		seoTitleTh: formState?.values?.seoTitleTh ?? existing?.localizations.th?.seoTitle ?? '',
		seoDescriptionTh:
			formState?.values?.seoDescriptionTh ?? existing?.localizations.th?.seoDescription ?? '',
		slugInput: formState?.values?.slugInput ?? existing?.slug ?? '',
		template: formState?.values?.template ?? existing?.template ?? 'default',
		status: formState?.values?.status ?? existing?.status ?? 'draft',
		publishedAtLocal:
			formState?.values?.publishedAtLocal ?? isoToLocalInput(existing?.publishedAt) ?? '',
	});

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

	const seed = initial();
	let titleEn = $state(seed.titleEn);
	let bodyEn = $state(seed.bodyEn);
	let seoTitleEn = $state(seed.seoTitleEn);
	let seoDescriptionEn = $state(seed.seoDescriptionEn);
	let titleTh = $state(seed.titleTh);
	let bodyTh = $state(seed.bodyTh);
	let seoTitleTh = $state(seed.seoTitleTh);
	let seoDescriptionTh = $state(seed.seoDescriptionTh);
	let slugInput = $state(seed.slugInput);
	let template = $state<PageRecord['template']>(seed.template);
	let status = $state<PageRecord['status']>(seed.status);
	let publishedAtLocal = $state(seed.publishedAtLocal);
	let loading = $state(false);

	let slugTouched = $state(Boolean(seed.slugInput));
	const derivedSlug = $derived(slugify(titleEn));
	const displayedSlug = $derived(slugTouched ? slugInput : derivedSlug);

	function onSlugInput(e: Event) {
		slugTouched = true;
		slugInput = (e.target as HTMLInputElement).value;
	}

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
		<div class="block">
			<span class="text-sm font-medium">{m.cms_body()}</span>
			<div class="mt-1">
				<MarkdownEditor
					bind:this={editorEn}
					bind:value={bodyEn}
					name="body_en"
					required
					rows={14}
					draftKey={`page:${draftScope}:body_en`}
				/>
			</div>
		</div>
		<details class="rounded-md border border-border bg-muted/20">
			<summary class="cursor-pointer px-3 py-2 text-sm font-medium">{m.cms_seo_section()}</summary>
			<div class="space-y-3 p-3 pt-2">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_title_label()}</span>
					<input
						name="seo_title_en"
						bind:value={seoTitleEn}
						placeholder={titleEn}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_description_label()}</span>
					<textarea
						name="seo_description_en"
						bind:value={seoDescriptionEn}
						rows="2"
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					></textarea>
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
		<div class="block">
			<span class="text-sm font-medium">{m.cms_body()}</span>
			<div class="mt-1">
				<MarkdownEditor
					bind:this={editorTh}
					bind:value={bodyTh}
					name="body_th"
					rows={14}
					draftKey={`page:${draftScope}:body_th`}
				/>
			</div>
		</div>
		<details class="rounded-md border border-border bg-muted/20">
			<summary class="cursor-pointer px-3 py-2 text-sm font-medium">{m.cms_seo_section()}</summary>
			<div class="space-y-3 p-3 pt-2">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_title_label()}</span>
					<input
						name="seo_title_th"
						bind:value={seoTitleTh}
						placeholder={titleTh}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.cms_seo_description_label()}</span>
					<textarea
						name="seo_description_th"
						bind:value={seoDescriptionTh}
						rows="2"
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					></textarea>
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
			<span class="text-xs text-muted-foreground">{m.cms_pages_slug_help()}</span>
		</label>
		<label class="block">
			<span class="text-sm font-medium">{m.cms_pages_template()}</span>
			<select
				name="template"
				bind:value={template}
				class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
			>
				<option value="default">default</option>
				<option value="landing">landing</option>
				<option value="legal">legal</option>
			</select>
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
		</label>
	</section>

	<div class="flex items-center justify-between">
		<a href="/cms/pages" class="text-sm text-muted-foreground hover:underline">
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
