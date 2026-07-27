<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import PageForm from '../PageForm.svelte';

	let { form } = $props();
</script>

<svelte:head>
	<title>{m.cms_pages_new()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="max-w-3xl mx-auto">
	<h1 class="text-2xl font-bold mb-6">{m.cms_pages_new()}</h1>
	<PageForm formState={form} action="" submitLabel={m.cms_save()} />
</div>
