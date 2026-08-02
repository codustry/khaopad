<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import ArticleForm from '../ArticleForm.svelte';
	import { PageShell, PageHeader } from '$lib/components/admin';
	let { data, form } = $props();
</script>

<svelte:head>
	<title>{m.cms_new_article()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="form">
	<PageHeader
		title={m.cms_new_article()}
		breadcrumbs={[
			{ label: m.cms_articles(), href: resolve('/(admin)/admin/articles') },
			{ label: m.cms_new_article() }
		]}
	/>
	<ArticleForm
		formState={form}
		submitLabel={m.cms_save_draft()}
		categories={data.categories}
		tags={data.tags}
	/>
</PageShell>
