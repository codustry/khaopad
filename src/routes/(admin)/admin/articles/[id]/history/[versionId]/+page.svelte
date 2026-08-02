<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
	import { History } from 'lucide-svelte';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import type { PageData } from './$types';

	let {
		data,
		form,
	}: { data: PageData; form: { ok?: boolean; error?: string } | null } = $props();

	// ArticleRecord carries no top-level title; the crumb label comes from the
	// English localization, falling back to the slug.
	const articleTitle = $derived(data.article.localizations.en?.title ?? data.article.slug);

	function formatTimestamp(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	const titleChanged = $derived(data.diff.title.before !== data.diff.title.after);
	const excerptChanged = $derived(data.diff.excerpt.before !== data.diff.excerpt.after);
	const bodyChanged = $derived(data.diff.body.some((op) => op.kind !== 'equal'));
	const hasAnyChange = $derived(titleChanged || excerptChanged || bodyChanged);
</script>

<svelte:head>
	<title>v{data.version.version} {data.version.locale.toUpperCase()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="default">
	<PageHeader
		title="v{data.version.version} · {data.version.locale.toUpperCase()}"
		description={formatTimestamp(data.version.createdAt)}
		icon={History}
		breadcrumbs={[
			{ label: 'Articles', href: resolve('/(admin)/admin/articles') },
			{
				label: articleTitle,
				href: resolve('/(admin)/admin/articles/[id]', { id: data.article.id }),
			},
			{
				label: m.cms_history_title(),
				href: resolve('/(admin)/admin/articles/[id]/history', { id: data.article.id }),
			},
			{ label: `v${data.version.version}` },
		]}
	>
		{#snippet actions()}
			<form
				method="POST"
				action="?/restore"
				use:enhance={({ cancel }) => {
					if (!confirm(m.cms_history_restore_confirm())) {
						cancel();
						return;
					}
					return async ({ update }) => update();
				}}
			>
				<Button type="submit">{m.cms_history_restore()}</Button>
			</form>
		{/snippet}
	</PageHeader>

	{#if form?.error}
		<div
			class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
		>
			{form.error}
		</div>
	{/if}

	{#if !hasAnyChange}
		<Card>
			<CardContent class="p-6 text-sm text-muted-foreground">
				{m.cms_history_no_diff()}
			</CardContent>
		</Card>
	{:else}
		<div class="space-y-4">
			{#if titleChanged}
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">{m.cms_title_en()} / {m.cms_title_th()}</CardTitle>
					</CardHeader>
					<CardContent class="space-y-2 text-sm">
						<div class="rounded bg-red-100 px-3 py-1.5 text-red-800 line-through dark:bg-red-500/15 dark:text-red-300">
							{data.diff.title.before}
						</div>
						<div class="rounded bg-green-100 px-3 py-1.5 text-green-800 dark:bg-green-500/15 dark:text-green-300">
							{data.diff.title.after}
						</div>
					</CardContent>
				</Card>
			{/if}

			{#if excerptChanged}
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">{m.cms_excerpt()}</CardTitle>
					</CardHeader>
					<CardContent class="space-y-2 text-sm">
						<div class="rounded bg-red-100 px-3 py-1.5 text-red-800 line-through dark:bg-red-500/15 dark:text-red-300">
							{data.diff.excerpt.before || '—'}
						</div>
						<div class="rounded bg-green-100 px-3 py-1.5 text-green-800 dark:bg-green-500/15 dark:text-green-300">
							{data.diff.excerpt.after || '—'}
						</div>
					</CardContent>
				</Card>
			{/if}

			{#if bodyChanged}
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">{m.cms_body()}</CardTitle>
					</CardHeader>
					<CardContent class="p-0">
						<pre class="overflow-x-auto p-4 text-xs leading-snug font-mono"><code>{#each data.diff.body as op, i (i)}{#if op.kind === 'equal'}<span class="text-muted-foreground">  {op.line}</span>
{:else if op.kind === 'del'}<span class="bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300">- {op.line}</span>
{:else}<span class="bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300">+ {op.line}</span>
{/if}{/each}</code></pre>
					</CardContent>
				</Card>
			{/if}
		</div>
	{/if}
</PageShell>
