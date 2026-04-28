<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui';
	import type { PageData } from './$types';

	let {
		data,
		form,
	}: { data: PageData; form: { ok?: boolean; error?: string } | null } = $props();

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

<section class="mx-auto w-full max-w-4xl">
	<header class="mb-6 flex flex-wrap items-center justify-between gap-3">
		<div>
			<a
				href={`/cms/articles/${data.article.id}/history`}
				class="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
					<path d="M19 12H5M12 19l-7-7 7-7" />
				</svg>
				{m.cms_history_back()}
			</a>
			<h1 class="mt-3 text-2xl font-semibold tracking-tight">
				<Badge variant="secondary">v{data.version.version}</Badge>
				<Badge variant="outline" class="ml-1">{data.version.locale.toUpperCase()}</Badge>
				<span class="ml-3 text-base font-normal text-muted-foreground">
					{formatTimestamp(data.version.createdAt)}
				</span>
			</h1>
		</div>

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
	</header>

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
						<div class="rounded bg-red-50 px-3 py-1.5 text-red-900 line-through dark:bg-red-950/30 dark:text-red-200">
							{data.diff.title.before}
						</div>
						<div class="rounded bg-green-50 px-3 py-1.5 text-green-900 dark:bg-green-950/30 dark:text-green-200">
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
						<div class="rounded bg-red-50 px-3 py-1.5 text-red-900 line-through dark:bg-red-950/30 dark:text-red-200">
							{data.diff.excerpt.before || '—'}
						</div>
						<div class="rounded bg-green-50 px-3 py-1.5 text-green-900 dark:bg-green-950/30 dark:text-green-200">
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
{:else if op.kind === 'del'}<span class="bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200">- {op.line}</span>
{:else}<span class="bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200">+ {op.line}</span>
{/if}{/each}</code></pre>
					</CardContent>
				</Card>
			{/if}
		</div>
	{/if}
</section>
