<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import ArticleForm from '../ArticleForm.svelte';
	import Sparkline from '$lib/components/analytics/Sparkline.svelte';
	import RelatedProductsEditor from '$lib/components/admin/RelatedProductsEditor.svelte';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import { Button } from '$lib/components/ui';
	import type { ArticleRecord, CategoryRecord, TagRecord } from '$lib/server/content/types';

	type RefKind = 'featured' | 'mentioned' | 'promoted';

	let {
		data,
		form,
	}: {
		data: {
			article: ArticleRecord;
			categories: CategoryRecord[];
			tags: TagRecord[];
			sparkline: Array<{ date: string; count: number }>;
			totalViews: number;
			productRefs: Array<{
				productId: string;
				refKind: RefKind;
				productTitle: string | null;
				productSlug: string | null;
			}>;
			productChoices: Array<{ id: string; title: string; slug: string }>;
		};
		form: { ok?: boolean; error?: string; status?: ArticleRecord['status'] } | null;
	} = $props();

	const isPublished = $derived(
		(form?.status ?? data.article.status) === 'published',
	);
</script>

<svelte:head>
	<title>{m.cms_edit_article()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="form">
	<PageHeader
		title={m.cms_edit_article()}
		breadcrumbs={[
			{ label: m.cms_articles(), href: resolve('/(admin)/admin/articles') },
			{ label: data.article.localizations.en?.title || data.article.slug }
		]}
	>
		{#snippet actions()}
			<Button
				variant="outline"
				href={resolve('/(admin)/admin/articles/[id]/history', { id: data.article.id })}
			>
				{m.cms_history_link()}
			</Button>
			<form method="POST" action="?/togglePublish" use:enhance>
				<Button type="submit" variant="outline">
					{isPublished ? m.cms_unpublish() : m.cms_publish()}
				</Button>
			</form>
			<form
				method="POST"
				action="?/delete"
				use:enhance={({ cancel }) => {
					if (!confirm(m.cms_delete_confirm())) {
						cancel();
						return;
					}
					return async ({ update }) => update();
				}}
			>
				<Button type="submit" variant="destructive">
					{m.cms_delete()}
				</Button>
			</form>
		{/snippet}
	</PageHeader>

	{#if data.sparkline.length > 0 && data.totalViews > 0}
		<div class="mb-6 flex items-center justify-between gap-4 rounded-lg border border-border p-4 bg-card">
			<div>
				<div class="text-xs font-medium text-muted-foreground">
					{m.cms_article_views_30d()}
				</div>
				<div class="text-2xl font-semibold tabular-nums mt-0.5">{data.totalViews}</div>
			</div>
			<div class="text-primary">
				<Sparkline points={data.sparkline} />
			</div>
		</div>
	{/if}

	<ArticleForm
		existing={data.article}
		formState={form}
		action="?/save"
		submitLabel={m.cms_save_draft()}
		categories={data.categories}
		tags={data.tags}
	/>

	<div class="mt-8">
		<RelatedProductsEditor
			currentRefs={data.productRefs.map((r) => ({
				productId: r.productId,
				refKind: r.refKind,
			}))}
			productChoices={data.productChoices}
		/>
	</div>
</PageShell>
