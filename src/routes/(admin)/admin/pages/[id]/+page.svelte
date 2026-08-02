<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { FileText } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
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

<PageShell width="form">
	<PageHeader title={m.cms_pages_edit()} icon={FileText}>
		{#snippet actions()}
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
				<Button type="submit" variant="destructive" size="sm">{m.cms_delete()}</Button>
			</form>
		{/snippet}
	</PageHeader>

	<PageForm
		existing={data.page}
		formState={form}
		action="?/save"
		submitLabel={m.cms_save()}
	/>
</PageShell>
