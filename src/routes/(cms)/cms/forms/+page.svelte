<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui';
	import type { FormRecord } from '$lib/server/content/types';

	let { data }: { data: { forms: FormRecord[] } } = $props();
</script>

<svelte:head>
	<title>{m.cms_forms()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_forms()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_forms_help()}</p>
		</div>
		<a
			href="/cms/forms/new"
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
		>
			{m.cms_forms_new()}
		</a>
	</header>

	{#if data.forms.length === 0}
		<div class="border border-dashed border-border rounded-lg p-8 text-center">
			<p class="text-sm text-muted-foreground">{m.cms_forms_empty()}</p>
		</div>
	{:else}
		<div class="border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
					<tr>
						<th class="text-left px-4 py-2">{m.cms_forms_col_label()}</th>
						<th class="text-left px-4 py-2">{m.cms_forms_col_endpoint()}</th>
						<th class="text-left px-4 py-2">{m.cms_forms_col_fields()}</th>
						<th class="text-left px-4 py-2">{m.col_status()}</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each data.forms as f (f.id)}
						<tr class="hover:bg-muted/20">
							<td class="px-4 py-3">
								<a href={`/cms/forms/${f.id}`} class="font-medium hover:underline">
									{f.label}
								</a>
							</td>
							<td class="px-4 py-3 font-mono text-xs text-muted-foreground">
								/api/forms/{f.key}
							</td>
							<td class="px-4 py-3 text-xs text-muted-foreground">
								{f.fields.length} {f.fields.length === 1 ? 'field' : 'fields'}
							</td>
							<td class="px-4 py-3">
								<Badge variant={f.enabled ? 'default' : 'secondary'}>
									{f.enabled ? m.cms_forms_enabled() : m.cms_forms_disabled()}
								</Badge>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
