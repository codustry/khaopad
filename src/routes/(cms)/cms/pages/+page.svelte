<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui';
	import type { PageRecord } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: { pages: PageRecord[] };
		form:
			| {
					ok?: boolean;
					seeded?: Array<{ id: string; slug: string }>;
					skipped?: Array<{ slug: string; reason: string }>;
					error?: string;
			  }
			| null;
	} = $props();
</script>

<svelte:head>
	<title>{m.cms_pages()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_pages()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_pages_help()}</p>
		</div>
		<a
			href="/cms/pages/new"
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
		>
			{m.cms_pages_new()}
		</a>
	</header>

	{#if form?.ok && form.seeded && form.seeded.length > 0}
		<div class="rounded-md border border-border bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-sm">
			<p class="font-medium text-emerald-900 dark:text-emerald-100">
				{m.cms_pages_seeded({ n: form.seeded.length.toString() })}
			</p>
			<ul class="mt-1 list-disc list-inside text-emerald-800 dark:text-emerald-200">
				{#each form.seeded as s (s.id)}
					<li>
						<a href={`/cms/pages/${s.id}`} class="underline hover:no-underline">/{s.slug}</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if data.pages.length === 0}
		<div class="border border-dashed border-border rounded-lg p-8 text-center space-y-3">
			<p class="text-sm text-muted-foreground">{m.cms_pages_empty()}</p>
			<form method="POST" action="?/seedLegal" use:enhance>
				<button
					type="submit"
					class="px-4 py-2 border border-border rounded-md text-sm hover:bg-muted"
				>
					{m.cms_pages_seed_legal()}
				</button>
			</form>
		</div>
	{:else}
		<div class="border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
					<tr>
						<th class="text-left px-4 py-2">{m.cms_pages_col_title()}</th>
						<th class="text-left px-4 py-2">{m.cms_pages_col_slug()}</th>
						<th class="text-left px-4 py-2">{m.col_status()}</th>
						<th class="text-left px-4 py-2">{m.cms_pages_col_template()}</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each data.pages as p (p.id)}
						<tr class="hover:bg-muted/20">
							<td class="px-4 py-3">
								<a href={`/cms/pages/${p.id}`} class="font-medium hover:underline">
									{p.localizations.en?.title ?? p.localizations.th?.title ?? '(untitled)'}
								</a>
							</td>
							<td class="px-4 py-3 font-mono text-xs text-muted-foreground">/{p.slug}</td>
							<td class="px-4 py-3">
								<Badge variant={p.status === 'published' ? 'default' : 'secondary'}>
									{p.status}
								</Badge>
							</td>
							<td class="px-4 py-3 text-xs text-muted-foreground">{p.template}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
