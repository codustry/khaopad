<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import ArticleForm from '../ArticleForm.svelte';
	import type { ArticleRecord, CategoryRecord, TagRecord } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: { article: ArticleRecord; categories: CategoryRecord[]; tags: TagRecord[] };
		form: { ok?: boolean; error?: string; status?: ArticleRecord['status'] } | null;
	} = $props();

	const isPublished = $derived(
		(form?.status ?? data.article.status) === 'published',
	);
</script>

<svelte:head>
	<title>{m.cms_edit_article()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="max-w-3xl mx-auto">
	<div class="flex items-center justify-between mb-6 gap-3 flex-wrap">
		<h1 class="text-2xl font-bold">{m.cms_edit_article()}</h1>
		<div class="flex items-center gap-2">
			<form method="POST" action="?/togglePublish" use:enhance>
				<button
					type="submit"
					class="px-3 py-1.5 border border-border rounded-md text-sm hover:bg-muted"
				>
					{isPublished ? m.cms_unpublish() : m.cms_publish()}
				</button>
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
				<button
					type="submit"
					class="px-3 py-1.5 border border-destructive text-destructive rounded-md text-sm hover:bg-destructive/10"
				>
					{m.cms_delete()}
				</button>
			</form>
		</div>
	</div>

	<ArticleForm
		existing={data.article}
		formState={form}
		action="?/save"
		submitLabel={m.cms_save_draft()}
		categories={data.categories}
		tags={data.tags}
	/>
</div>
