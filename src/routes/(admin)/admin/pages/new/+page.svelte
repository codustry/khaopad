<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { FileText } from 'lucide-svelte';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import PageForm from '../PageForm.svelte';

	let { form } = $props();
</script>

<svelte:head>
	<title>{m.cms_pages_new()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="form">
	<PageHeader title={m.cms_pages_new()} icon={FileText} />
	<PageForm formState={form} action="" submitLabel={m.cms_save()} />
</PageShell>
