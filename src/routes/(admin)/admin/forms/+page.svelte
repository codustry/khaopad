<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { FileText } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge } from '$lib/components/admin';
	import type { Column } from '$lib/components/admin';
	import type { FormRecord } from '$lib/server/content/types';

	let { data }: { data: { forms: FormRecord[] } } = $props();

	const columns: Column<FormRecord>[] = [
		{ key: 'label', header: m.cms_forms_col_label(), cell: labelCell },
		{ key: 'endpoint', header: m.cms_forms_col_endpoint(), cell: endpointCell },
		{ key: 'fields', header: m.cms_forms_col_fields(), cell: fieldsCell },
		{ key: 'status', header: m.col_status(), cell: statusCell },
	];
</script>

{#snippet labelCell(f: FormRecord)}
	<a
		href={resolve('/(admin)/admin/forms/[id]', { id: f.id })}
		class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{f.label}
	</a>
{/snippet}

{#snippet endpointCell(f: FormRecord)}
	<span class="font-mono text-xs text-muted-foreground">/api/forms/{f.key}</span>
{/snippet}

{#snippet fieldsCell(f: FormRecord)}
	<span class="text-xs text-muted-foreground">
		{f.fields.length}
		{f.fields.length === 1 ? 'field' : 'fields'}
	</span>
{/snippet}

{#snippet statusCell(f: FormRecord)}
	<StatusBadge
		status={f.enabled ? 'active' : 'archived'}
		label={f.enabled ? m.cms_forms_enabled() : m.cms_forms_disabled()}
	/>
{/snippet}

<svelte:head>
	<title>{m.cms_forms()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader title={m.cms_forms()} description={m.cms_forms_help()} icon={FileText}>
		{#snippet actions()}
			<Button href={resolve('/(admin)/admin/forms/new')}>
				{m.cms_forms_new()}
			</Button>
		{/snippet}
	</PageHeader>

	<DataTable
		columns={columns}
		rows={data.forms}
		getKey={(f) => f.id}
		caption={m.cms_forms()}
	>
		{#snippet empty()}
			<p class="text-sm text-muted-foreground">{m.cms_forms_empty()}</p>
		{/snippet}
	</DataTable>
</PageShell>
