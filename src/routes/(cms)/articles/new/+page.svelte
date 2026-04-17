<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import ArticleForm from '../ArticleForm.svelte';
	let { form } = $props();
</script>

<svelte:head>
	<title>{m.cms_new_article()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="max-w-3xl mx-auto">
	<h1 class="text-2xl font-bold mb-6">{m.cms_new_article()}</h1>
	<ArticleForm formState={form} submitLabel={m.cms_save_draft()} />
</div>
