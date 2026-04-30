<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import PageForm from '../PageForm.svelte';
	import type { PageRecord } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: { page: PageRecord };
		form: { ok?: boolean; error?: string } | null;
	} = $props();
</script>

<svelte:head>
	<title>{m.cms_pages_edit()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="max-w-3xl mx-auto">
	<div class="flex items-center justify-between mb-6 gap-3 flex-wrap">
		<h1 class="text-2xl font-bold">{m.cms_pages_edit()}</h1>
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

	<PageForm
		existing={data.page}
		formState={form}
		action="?/save"
		submitLabel={m.cms_save()}
	/>
</div>
