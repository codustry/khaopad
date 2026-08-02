<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Plus, Star } from 'lucide-svelte';
	import { Badge, Button, Input, Label } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		DataTable,
		StatusBadge,
	} from '$lib/components/admin';
	import type { Column } from '$lib/components/admin';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let newType = $state('text');
	let submitting = $state(false);

	const c = $derived(data.collection);

	/** Which extra config inputs the chosen field type needs. */
	const needsOptions = $derived(newType === 'enum');
	const needsTarget = $derived(newType === 'relation');
	const needsAllowed = $derived(newType === 'component');
	const needsCardinality = $derived(
		newType === 'relation' || newType === 'component' || newType === 'media'
	);
	/** Only document scalars can be promoted to an indexed column. */
	const canPromote = $derived(
		!['relation', 'component', 'json', 'richtext', 'media'].includes(newType)
	);

	const componentTargets = $derived(
		data.collectionChoices.filter((x) => x.kind === 'component')
	);
	const relationTargets = $derived(
		data.collectionChoices.filter((x) => x.kind !== 'component')
	);

	type Field = PageData['collection']['fields'][number];
	type Entry = PageData['entries'][number];

	const fieldColumns: Column<Field>[] = $derived([
		{ key: 'apiId', header: 'API id', cell: fieldApiIdCell },
		{ key: 'type', header: 'Type', cell: fieldTypeCell },
		{ key: 'flags', header: 'Flags', cell: fieldFlagsCell },
		...(data.canEditSchema
			? [
					{
						key: 'actions',
						header: '',
						align: 'right' as const,
						class: 'w-20',
						cell: fieldActionsCell,
					},
				]
			: []),
	]);

	const entryColumns: Column<Entry>[] = $derived([
		{ key: 'slug', header: 'Slug', cell: entrySlugCell },
		{ key: 'status', header: 'Status', cell: entryStatusCell },
		{ key: 'updatedAt', header: 'Updated', cell: entryUpdatedCell },
		{
			key: 'actions',
			header: '',
			align: 'right',
			class: 'w-32',
			cell: entryActionsCell,
		},
	]);
</script>

{#snippet fieldApiIdCell(f: Field)}
	<code class="font-mono">{f.apiId}</code>
{/snippet}

{#snippet fieldTypeCell(f: Field)}
	<span class="text-xs text-muted-foreground">{f.type}</span>
{/snippet}

{#snippet fieldFlagsCell(f: Field)}
	<div class="flex flex-wrap gap-1">
		{#if f.required}<Badge variant="outline">required</Badge>{/if}
		{#if f.localized}<Badge variant="outline">i18n</Badge>{/if}
		{#if f.unique}<Badge variant="outline">unique</Badge>{/if}
		{#if f.promoted}
			<Badge title="Indexed generated column">
				<Star class="mr-1 h-3 w-3" />indexed
			</Badge>
		{/if}
	</div>
{/snippet}

{#snippet fieldActionsCell(f: Field)}
	<form method="POST" action="?/removeField" use:enhance>
		<input type="hidden" name="apiId" value={f.apiId} />
		<Button type="submit" variant="ghost" size="sm" class="text-destructive">
			Remove
		</Button>
	</form>
{/snippet}

{#snippet entrySlugCell(e: Entry)}
	<code class="font-mono text-xs">{e.slug ?? e.id}</code>
{/snippet}

{#snippet entryStatusCell(e: Entry)}
	<StatusBadge status={e.status} />
{/snippet}

{#snippet entryUpdatedCell(e: Entry)}
	<span class="text-xs text-muted-foreground">
		{e.updatedAt.slice(0, 16).replace('T', ' ')}
	</span>
{/snippet}

{#snippet entryActionsCell(e: Entry)}
	<div class="flex items-center justify-end gap-1">
		<Button
			href={resolve('/(admin)/admin/content/[collection]/[id]', {
				collection: c.apiId,
				id: e.id,
			})}
			variant="ghost"
			size="sm"
		>
			Edit
		</Button>
		<form method="POST" action="?/deleteEntry" use:enhance>
			<input type="hidden" name="id" value={e.id} />
			<Button type="submit" variant="ghost" size="sm" class="text-destructive">
				Delete
			</Button>
		</form>
	</div>
{/snippet}

<PageShell width="wide">
	<PageHeader
		title={c.apiId}
		breadcrumbs={[
			{ label: 'Content types', href: resolve('/(admin)/admin/content') },
			{ label: c.apiId },
		]}
		class="[&_h1]:font-mono"
	>
		{#snippet actions()}
			<Badge variant="outline">{c.kind}</Badge>
			{#if c.localized}<Badge variant="outline">i18n</Badge>{/if}
		{/snippet}
	</PageHeader>

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

	<!-- ── Fields ───────────────────────────────────────────── -->
	<section class="mb-6 space-y-3">
		<h2
			class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
		>
			Fields ({c.fields.length})
		</h2>

		{#if c.fields.length > 0}
			<DataTable
				columns={fieldColumns}
				rows={c.fields}
				getKey={(f) => f.id}
				caption="Fields"
			/>
		{:else}
			<p class="text-sm text-muted-foreground">
				No fields yet — add one below before creating entries.
			</p>
		{/if}

		{#if data.canEditSchema}
			<details class="rounded-lg border border-border p-4">
				<summary class="cursor-pointer text-sm font-medium">Add a field</summary>
				<form
					method="POST"
					action="?/addField"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							await update({ reset: true });
							submitting = false;
						};
					}}
					class="mt-4 space-y-3"
				>
					<div class="grid grid-cols-3 gap-3">
						<div class="space-y-1">
							<Label for="apiId" class="text-xs">API id</Label>
							<Input id="apiId" name="apiId" required maxlength={63} />
						</div>
						<div class="space-y-1">
							<Label for="type" class="text-xs">Type</Label>
							<select
								id="type"
								name="type"
								bind:value={newType}
								class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
							>
								{#each data.fieldTypes as t (t)}
									<option value={t}>{t}</option>
								{/each}
							</select>
						</div>
						<div class="space-y-1">
							<Label for="position" class="text-xs">Position</Label>
							<Input id="position" name="position" type="number" value="0" />
						</div>
					</div>

					{#if needsOptions}
						<div class="space-y-1">
							<Label for="options" class="text-xs">
								Options (comma-separated)
							</Label>
							<Input
								id="options"
								name="options"
								required
								placeholder="draft, review, live"
							/>
						</div>
					{/if}

					{#if needsTarget}
						<div class="space-y-1">
							<Label for="target" class="text-xs">Target content type</Label>
							<select
								id="target"
								name="target"
								required
								class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
							>
								{#each relationTargets as t (t.apiId)}
									<option value={t.apiId}>{t.apiId}</option>
								{/each}
							</select>
						</div>
					{/if}

					{#if needsAllowed}
						<div class="space-y-1">
							<Label for="allowed" class="text-xs">
								Allowed components (comma-separated)
							</Label>
							<Input
								id="allowed"
								name="allowed"
								required
								placeholder={componentTargets.map((t) => t.apiId).join(', ') ||
									'create a component type first'}
							/>
							<p class="text-xs text-muted-foreground">
								Must be component-kind types. Several makes it a dynamic zone.
							</p>
						</div>
					{/if}

					{#if needsCardinality}
						<div class="space-y-1">
							<Label for="cardinality" class="text-xs">Cardinality</Label>
							<select
								id="cardinality"
								name="cardinality"
								class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
							>
								<option value="one">one</option>
								<option value="many">many (ordered)</option>
							</select>
						</div>
					{/if}

					<div class="flex flex-wrap gap-5 text-sm">
						<label class="flex items-center gap-2">
							<input type="hidden" name="required" value="false" />
							<input
								type="checkbox"
								name="required"
								value="true"
								class="h-4 w-4 rounded border-input"
							/>
							Required
						</label>
						{#if c.localized}
							<label class="flex items-center gap-2">
								<input type="hidden" name="localized" value="false" />
								<input
									type="checkbox"
									name="localized"
									value="true"
									class="h-4 w-4 rounded border-input"
								/>
								Per-locale
							</label>
						{/if}
						<label class="flex items-center gap-2">
							<input type="hidden" name="unique" value="false" />
							<input
								type="checkbox"
								name="unique"
								value="true"
								class="h-4 w-4 rounded border-input"
							/>
							Unique
						</label>
						{#if canPromote}
							<label class="flex items-center gap-2">
								<input type="hidden" name="promoted" value="false" />
								<input
									type="checkbox"
									name="promoted"
									value="true"
									class="h-4 w-4 rounded border-input"
								/>
								Indexed
								<span class="text-xs text-muted-foreground">
									(needed to filter/sort by it — spends part of D1's
									100-column budget)
								</span>
							</label>
						{/if}
					</div>

					<div class="flex justify-end">
						<Button type="submit" disabled={submitting}>
							<Plus class="mr-2 h-4 w-4" />
							{submitting ? 'Adding…' : 'Add field'}
						</Button>
					</div>
				</form>
			</details>
		{/if}
	</section>

	<!-- ── Entries ──────────────────────────────────────────── -->
	<section class="space-y-3">
		<div class="flex items-baseline justify-between">
			<h2
				class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
			>
				Entries
			</h2>
			{#if c.fields.length > 0}
				<Button
					href={resolve('/(admin)/admin/content/[collection]/[id]', {
						collection: c.apiId,
						id: 'new',
					})}
					size="sm"
				>
					<Plus class="mr-2 h-4 w-4" /> New entry
				</Button>
			{/if}
		</div>

		<DataTable
			columns={entryColumns}
			rows={data.entries}
			getKey={(e) => e.id}
			caption="Entries"
		>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">
					{c.fields.length === 0
						? 'Add a field first, then create entries.'
						: 'No entries yet.'}
				</p>
			{/snippet}
		</DataTable>
		{#if data.entries.length > 0 && data.entries.length === data.entryPageSize}
			<p class="text-xs text-muted-foreground">
				Showing the {data.entryPageSize} most recently updated. Paging lands
				with the list-view work.
			</p>
		{/if}
	</section>
</PageShell>
