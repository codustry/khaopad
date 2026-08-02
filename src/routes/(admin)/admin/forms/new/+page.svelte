<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import FormEditor from '../FormEditor.svelte';

	let { form } = $props();
</script>

<svelte:head>
	<title>{m.cms_forms_new()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="form">
	<PageHeader
		title={m.cms_forms_new()}
		breadcrumbs={[
			{ label: m.cms_forms(), href: resolve('/(admin)/admin/forms') },
			{ label: m.cms_forms_new() },
		]}
	/>
	<FormEditor formState={form} action="" submitLabel={m.cms_forms_create()} />
</PageShell>
