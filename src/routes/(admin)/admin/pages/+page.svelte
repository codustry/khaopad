<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		DataTable,
		TableToolbar,
		StatusBadge,
		type Column
	} from '$lib/components/admin';
	import { Files } from 'lucide-svelte';
	import type { PageRecord } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: { pages: PageRecord[]; search: string };
		form:
			| {
					ok?: boolean;
					seeded?: Array<{ id: string; slug: string }>;
					skipped?: Array<{ slug: string; reason: string }>;
					error?: string;
			  }
			| null;
	} = $props();

	const columns: Column<PageRecord>[] = [
		{ key: 'title', header: m.cms_pages_col_title(), cell: titleCell },
		{ key: 'slug', header: m.cms_pages_col_slug(), cell: slugCell },
		{ key: 'status', header: m.col_status(), cell: statusCell },
		{ key: 'template', header: m.cms_pages_col_template(), cell: templateCell }
	];
</script>

{#snippet titleCell(p: PageRecord)}
	<a
		href={resolve('/(admin)/admin/pages/[id]', { id: p.id })}
		class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{p.localizations.en?.title ?? p.localizations.th?.title ?? '(untitled)'}
	</a>
{/snippet}

{#snippet slugCell(p: PageRecord)}
	<span class="font-mono text-xs text-muted-foreground">/{p.slug}</span>
{/snippet}

{#snippet statusCell(p: PageRecord)}
	<StatusBadge status={p.status} />
{/snippet}

{#snippet templateCell(p: PageRecord)}
	<span class="text-xs text-muted-foreground">{p.template}</span>
{/snippet}

<svelte:head>
	<title>{m.cms_pages()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader title={m.cms_pages()} description={m.cms_pages_help()} icon={Files}>
		{#snippet actions()}
			<Button href={resolve('/(admin)/admin/pages/new')}>{m.cms_pages_new()}</Button>
		{/snippet}
	</PageHeader>

	<TableToolbar searchPlaceholder={m.cms_search_pages()} />

	<div class="space-y-6">
		{#if form?.ok && form.seeded && form.seeded.length > 0}
			<div class="rounded-md border border-border bg-emerald-50 px-4 py-3 text-sm dark:bg-emerald-950/30">
				<p class="font-medium text-emerald-900 dark:text-emerald-100">
					{m.cms_pages_seeded({ n: form.seeded.length.toString() })}
				</p>
				<ul class="mt-1 list-inside list-disc text-emerald-800 dark:text-emerald-200">
					{#each form.seeded as s (s.id)}
						<li>
							<a
								href={resolve('/(admin)/admin/pages/[id]', { id: s.id })}
								class="underline hover:no-underline">/{s.slug}</a
							>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<DataTable columns={columns} rows={data.pages} getKey={(p) => p.id}>
			{#snippet empty()}
				{#if data.search}
					<!-- A search matching nothing must not read as "you have no pages". -->
					<p class="text-sm text-muted-foreground">{m.admin_no_results()}</p>
				{:else}
					<div class="space-y-3">
						<p class="text-sm text-muted-foreground">{m.cms_pages_empty()}</p>
						<form method="POST" action="?/seedLegal" use:enhance>
							<Button type="submit" variant="outline">{m.cms_pages_seed_legal()}</Button>
						</form>
					</div>
				{/if}
			{/snippet}
		</DataTable>
	</div>
</PageShell>
