<script lang="ts">
	/**
	 * Registry-driven entry editor — Phase 4 (#68 §F).
	 *
	 * Every input here is generated from `collection_fields`. Nothing in
	 * this file knows what an "article" or a "product" is, which is the
	 * point: a content type added by inserting registry rows gets a
	 * working editor with no new code.
	 */
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Save, History } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, StatusBadge } from '$lib/components/admin';
	import RegistryField from '$lib/components/admin/registry/RegistryField.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
	// `defaultLocale` is a site-wide setting that never varies per navigation,
	// so seeding the tab selection once is intended. Per-record staleness is
	// handled by the {#key data.entry?.id} wrap around the form below.
	// svelte-ignore state_referenced_locally
	let activeLocale = $state(data.defaultLocale);

	const c = $derived(data.collection);
	const sharedFields = $derived(c.fields.filter((f) => !f.localized));
	const localizedFields = $derived(c.fields.filter((f) => f.localized));
	const justCreated = $derived(page.url.searchParams.get('created') === '1');

	function docValue(apiId: string): unknown {
		return data.values.document[apiId];
	}
	function locValue(locale: string, apiId: string): unknown {
		return data.values.localized[locale]?.[apiId];
	}
</script>

{#snippet headerActions()}
	{#if data.entry}
		<StatusBadge status={data.entry.status} />
	{/if}
	{#if data.versionCount > 0}
		<span
			class="flex items-center gap-1 text-xs text-muted-foreground"
			title="Snapshots taken on each save"
		>
			<History class="h-3 w-3" />
			{data.versionCount}
			{data.versionCount === 1 ? 'version' : 'versions'}
		</span>
	{/if}
{/snippet}

<PageShell width="form">
	<PageHeader
		title={data.isNew ? 'New entry' : (data.entry?.slug ?? 'Entry')}
		breadcrumbs={[
			{
				label: c.apiId,
				href: resolve('/(admin)/admin/content/[collection]', {
					collection: c.apiId,
				}),
			},
			{ label: data.isNew ? 'New entry' : (data.entry?.slug ?? 'Entry') },
		]}
		actions={headerActions}
	/>

	{#if justCreated}
		<div
			class="mb-6 rounded-md border border-green-600/50 bg-green-600/10 p-3 text-sm text-green-700 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300"
		>
			Entry created.
		</div>
	{/if}
	{#if form?.error}
		<div
			class="mb-6 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
		>
			{form.error}
		</div>
	{/if}
	{#if form?.success && form.message}
		<div
			class="mb-6 rounded-md border border-green-600/50 bg-green-600/10 p-3 text-sm text-green-700 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300"
		>
			{form.message}
		</div>
	{/if}

	{#if c.fields.length === 0}
		<div class="rounded-lg border border-dashed border-border p-8 text-center">
			<p class="text-sm text-muted-foreground">
				This type has no fields yet. Add fields before creating entries.
			</p>
		</div>
	{:else}
		<!--
			Keyed per record: client-side navigation between two entries reuses
			this component, and children (e.g. MarkdownEditor's draft baseline)
			capture their seed values on mount. Remount them for each entry.
		-->
		{#key data.entry?.id ?? 'new'}
		<form
			method="POST"
			action="?/save"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					submitting = false;
				};
			}}
			class="space-y-6"
		>
			<!-- ── Entry-level fields ────────────────────────── -->
			<section class="grid grid-cols-2 gap-3 rounded-lg border border-border p-4">
				<div class="space-y-1">
					<Label for="slug" class="text-xs">Slug</Label>
					<Input
						id="slug"
						name="slug"
						value={data.entry?.slug ?? ''}
						placeholder={c.kind === 'component'
							? 'not used for components'
							: 'auto-derived from title/name'}
						disabled={c.kind === 'component'}
					/>
					<p class="text-xs text-muted-foreground">
						Shared across locales. Leave blank to derive it.
					</p>
				</div>
				{#if c.draftPublish}
					<div class="space-y-1">
						<Label for="status" class="text-xs">Status</Label>
						<select
							id="status"
							name="status"
							class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
						>
							{#each ['draft', 'published', 'archived'] as s (s)}
								<option value={s} selected={(data.entry?.status ?? 'draft') === s}>
									{s}
								</option>
							{/each}
						</select>
					</div>
				{/if}
			</section>

			<!-- ── Shared (non-localized) fields ─────────────── -->
			{#if sharedFields.length > 0}
				<section class="space-y-4 rounded-lg border border-border p-4">
					<h2
						class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
					>
						Fields
					</h2>
					{#each sharedFields as field (field.id)}
						<RegistryField
							{field}
							value={data.values.relations[field.apiId] ??
								docValue(field.apiId)}
							uiLocale={data.defaultLocale}
							relationChoices={data.relationChoices[field.apiId] ?? []}
						/>
					{/each}
				</section>
			{/if}

			<!-- ── Localized fields, one tab per locale ──────── -->
			{#if localizedFields.length > 0}
				<section class="space-y-4 rounded-lg border border-border p-4">
					<div class="flex items-center justify-between">
						<h2
							class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
						>
							Translations
						</h2>
						<div class="flex gap-1">
							{#each data.supportedLocales as locale (locale)}
								<Button
									type="button"
									variant={activeLocale === locale ? 'default' : 'ghost'}
									size="sm"
									onclick={() => (activeLocale = locale)}
								>
									{locale}
								</Button>
							{/each}
						</div>
					</div>

					<!--
						Every locale's inputs stay MOUNTED, just visually hidden —
						they must all post, or switching tabs before save would
						silently drop the other locales' edits.
					-->
					{#each data.supportedLocales as locale (locale)}
						<div
							class="space-y-4"
							class:hidden={activeLocale !== locale}
							aria-hidden={activeLocale !== locale}
						>
							{#each localizedFields as field (field.id)}
								<RegistryField
									{field}
									{locale}
									value={locValue(locale, field.apiId)}
									uiLocale={data.defaultLocale}
								/>
							{/each}
						</div>
					{/each}

					{#if data.supportedLocales.length > 1}
						<p class="text-xs text-muted-foreground">
							Required translations are only enforced for
							<code>{data.defaultLocale}</code> — a partially translated entry
							is a normal editorial state.
						</p>
					{/if}
				</section>
			{/if}

			<div class="flex items-center justify-between">
				<p class="text-xs text-muted-foreground">
					{#if data.entry}
						Last updated {data.entry.updatedAt.slice(0, 16).replace('T', ' ')}
					{/if}
				</p>
				<Button type="submit" disabled={submitting}>
					<Save class="mr-2 h-4 w-4" />
					{submitting ? 'Saving…' : data.isNew ? 'Create' : 'Save'}
				</Button>
			</div>
		</form>
		{/key}
	{/if}
</PageShell>
