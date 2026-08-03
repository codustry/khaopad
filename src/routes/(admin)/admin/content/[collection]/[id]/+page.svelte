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
	import { Save, History, Trash2 } from 'lucide-svelte';
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

	// ── Specifications (#130) ─────────────────────────────────
	let specAttrKey = $state('');
	let specSubmitting = $state(false);
	const specAttr = $derived(data.specAttributes.find((a) => a.key === specAttrKey));

	type SpecValue = (typeof data.specValues)[number];
	// Grouped by attribute for display; rows arrive in definition order.
	// A plain object, not a Map: the whole structure is rebuilt on every
	// derived evaluation, so reactive collection types buy nothing here —
	// and the lint rule can't tell a rebuilt-per-run Map from a mutated one.
	const specGroups = $derived.by(() => {
		const groups: Record<string, SpecValue[]> = {};
		for (const v of data.specValues) {
			(groups[v.attributeKey] ??= []).push(v);
		}
		return Object.entries(groups);
	});

	function formatSpecValue(v: SpecValue): string {
		if (v.dataType === 'boolean') return v.displayValue === true ? 'yes' : 'no';
		if (Array.isArray(v.displayValue)) return v.displayValue.join(', ');
		const base = v.displayValue === null ? '—' : String(v.displayValue);
		// A non-null max means the value is a genuine range.
		const range = v.displayValueMax === null ? base : `${base}–${v.displayValueMax}`;
		return v.unit ? `${range} ${v.unit}` : range;
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
							relationTotal={data.relationTotals[field.apiId] ?? 0}
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

	<!-- ── Specifications (#130) ─────────────────────────────
	     Typed attribute values on this entry. A sidecar to the entry
	     document, so it lives OUTSIDE the save form: each value posts
	     its own action and the entry form never has to round-trip. -->
	{#if !data.isNew && data.entry}
		<section class="mt-6 space-y-4 rounded-lg border border-border p-4">
			<h2
				class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
			>
				Specifications
			</h2>

			{#if form && 'specError' in form && form.specError}
				<div
					class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
				>
					{form.specError}
				</div>
			{/if}
			{#if form && 'specSuccess' in form && form.specSuccess}
				<div
					class="rounded-md border border-green-600/50 bg-green-600/10 p-3 text-sm text-green-700 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-300"
				>
					{form.specSuccess}
				</div>
			{/if}

			{#if data.specAttributes.length === 0}
				<p class="text-sm text-muted-foreground">
					No attributes defined yet. Define attributes under
					<a href={resolve('/(admin)/admin/specs')} class="underline underline-offset-2">Specs</a>
					to add typed values here.
				</p>
			{:else}
				{#if specGroups.length === 0}
					<p class="text-sm text-muted-foreground">No values yet.</p>
				{:else}
					<ul class="divide-y divide-border">
						{#each specGroups as [attributeKey, values] (attributeKey)}
							<li class="space-y-1 py-2">
								<p class="text-xs font-medium">{attributeKey}</p>
								{#each values as v (`${v.attributeKey}|${v.qualifier ?? ''}|${v.locale ?? ''}`)}
									<div class="flex items-center gap-2 text-sm">
										<span class="flex-1">
											{formatSpecValue(v)}
										</span>
										{#if v.qualifier}
											<span
												class="rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
												title="Qualifier"
											>
												{v.qualifier}
											</span>
										{/if}
										{#if v.locale}
											<span
												class="rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
												title="Locale"
											>
												{v.locale}
											</span>
										{/if}
										<form
											method="POST"
											action="?/removeSpecValue"
											use:enhance={() => {
												specSubmitting = true;
												return async ({ update }) => {
													await update();
													specSubmitting = false;
												};
											}}
										>
											<input type="hidden" name="attributeKey" value={v.attributeKey} />
											<input type="hidden" name="qualifier" value={v.qualifier ?? ''} />
											<input type="hidden" name="locale" value={v.locale ?? ''} />
											<Button
												type="submit"
												variant="ghost"
												size="sm"
												disabled={specSubmitting}
												aria-label="Remove {v.attributeKey} value"
											>
												<Trash2 class="h-3.5 w-3.5" />
											</Button>
										</form>
									</div>
								{/each}
							</li>
						{/each}
					</ul>
				{/if}

				<!-- Add / update a value. `reset: false` is deliberate NOT
				     used here: after a save the row list refreshes and the
				     inputs should clear for the next value. -->
				<form
					method="POST"
					action="?/setSpecValue"
					use:enhance={() => {
						specSubmitting = true;
						return async ({ update }) => {
							await update();
							specSubmitting = false;
						};
					}}
					class="space-y-3 rounded-md border border-dashed border-border p-3"
				>
					<div class="space-y-1">
						<Label for="spec-attribute" class="text-xs">Attribute</Label>
						<!-- A datalist keeps the picker searchable without a
						     dependency; the value is the machine key. -->
						<input
							id="spec-attribute"
							name="attributeKey"
							list="spec-attribute-options"
							bind:value={specAttrKey}
							placeholder="Type to search attributes…"
							autocomplete="off"
							class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						/>
						<datalist id="spec-attribute-options">
							{#each data.specAttributes as a (a.key)}
								<option value={a.key}>{a.dataType}</option>
							{/each}
						</datalist>
					</div>

					{#if specAttr}
						<div class="flex flex-wrap items-end gap-3">
							{#if specAttr.dataType === 'number' || specAttr.dataType === 'measurement'}
								<div class="space-y-1">
									<Label for="spec-value" class="text-xs">Value</Label>
									<Input
										id="spec-value"
										name="value"
										type="number"
										step="any"
										required
										class="w-32"
									/>
								</div>
								<div class="space-y-1">
									<Label for="spec-max" class="text-xs">Max (range)</Label>
									<Input
										id="spec-max"
										name="max"
										type="number"
										step="any"
										placeholder="optional"
										class="w-32"
									/>
								</div>
								{#if specAttr.dataType === 'measurement' && specAttr.measureFamily}
									<div class="space-y-1">
										<Label for="spec-unit" class="text-xs">Unit</Label>
										<select
											id="spec-unit"
											name="unit"
											required
											class="rounded-md border border-input bg-transparent px-3 py-2 text-sm"
										>
											{#each data.unitsByFamily[specAttr.measureFamily] ?? [] as unit (unit)}
												<option value={unit} selected={unit === specAttr.standardUnit}>
													{unit}
												</option>
											{/each}
										</select>
									</div>
								{/if}
							{:else if specAttr.dataType === 'select'}
								<div class="space-y-1">
									<Label for="spec-option" class="text-xs">Option</Label>
									<select
										id="spec-option"
										name="option"
										required
										class="rounded-md border border-input bg-transparent px-3 py-2 text-sm"
									>
										{#each specAttr.options as option (option)}
											<option value={option}>{option}</option>
										{/each}
									</select>
								</div>
							{:else if specAttr.dataType === 'multiselect'}
								<fieldset class="space-y-1">
									<legend class="text-xs font-medium">Options</legend>
									<div class="flex flex-wrap gap-3">
										{#each specAttr.options as option (option)}
											<label class="flex items-center gap-1.5 text-sm">
												<input
													type="checkbox"
													name="options"
													value={option}
													class="h-4 w-4 rounded border-input"
												/>
												{option}
											</label>
										{/each}
									</div>
								</fieldset>
							{:else if specAttr.dataType === 'boolean'}
								<label class="flex items-center gap-2 text-sm">
									<input type="hidden" name="bool" value="false" />
									<input
										type="checkbox"
										name="bool"
										value="true"
										class="h-4 w-4 rounded border-input"
									/>
									Yes
								</label>
							{:else if specAttr.dataType === 'text'}
								<div class="min-w-48 flex-1 space-y-1">
									<Label for="spec-text" class="text-xs">Text</Label>
									<Input id="spec-text" name="text" required />
								</div>
								<div class="space-y-1">
									<Label for="spec-locale" class="text-xs">Locale</Label>
									<select
										id="spec-locale"
										name="locale"
										class="rounded-md border border-input bg-transparent px-3 py-2 text-sm"
									>
										<option value="">— none —</option>
										{#each data.supportedLocales as locale (locale)}
											<option value={locale}>{locale}</option>
										{/each}
									</select>
								</div>
							{/if}

							<div class="space-y-1">
								<Label for="spec-qualifier" class="text-xs">Qualifier</Label>
								<Input
									id="spec-qualifier"
									name="qualifier"
									placeholder="optional, e.g. 50hz"
									list={specAttr.qualifiers.length > 0 ? 'spec-qualifier-options' : undefined}
									class="w-36"
								/>
								{#if specAttr.qualifiers.length > 0}
									<datalist id="spec-qualifier-options">
										{#each specAttr.qualifiers as q (q)}
											<option value={q}></option>
										{/each}
									</datalist>
								{/if}
							</div>

							<Button type="submit" size="sm" disabled={specSubmitting}>
								{specSubmitting ? 'Saving…' : 'Add value'}
							</Button>
						</div>
					{:else if specAttrKey.trim()}
						<p class="text-xs text-muted-foreground">
							No attribute named "{specAttrKey}". Pick one from the list.
						</p>
					{/if}
				</form>
			{/if}
		</section>
	{/if}
</PageShell>
