<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Database, Plus, Layers, Box } from 'lucide-svelte';
	import { Badge, Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable } from '$lib/components/admin';
	import type { Column } from '$lib/components/admin';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
	let confirmFor = $state<string | null>(null);

	const KIND_ICON = { collection: Layers, single: Box, component: Box };

	type Collection = PageData['collections'][number];

	const columns: Column<Collection>[] = [
		{ key: 'apiId', header: 'API id', cell: apiIdCell },
		{ key: 'kind', header: 'Kind', cell: kindCell },
		{ key: 'fieldCount', header: 'Fields', align: 'right', numeric: true, cell: fieldsCell },
		{ key: 'entryCount', header: 'Entries', align: 'right', numeric: true },
		{ key: 'flags', header: 'Flags', cell: flagsCell },
		{ key: 'actions', header: '', align: 'right', class: 'w-40', cell: actionsCell },
	];
</script>

{#snippet apiIdCell(c: Collection)}
	{@const Icon = KIND_ICON[c.kind] ?? Layers}
	<div class="flex items-center gap-2">
		<Icon class="h-4 w-4 text-muted-foreground" />
		<code class="font-mono font-medium">{c.apiId}</code>
	</div>
	{#if c.description}
		<div class="mt-0.5 text-xs text-muted-foreground">{c.description}</div>
	{/if}
{/snippet}

{#snippet kindCell(c: Collection)}
	<span class="text-xs text-muted-foreground">{c.kind}</span>
{/snippet}

{#snippet fieldsCell(c: Collection)}
	{c.fieldCount}
	{#if c.promotedCount > 0}
		<span
			class="text-muted-foreground"
			title="{c.promotedCount} promoted to indexed columns"
		>
			({c.promotedCount}★)
		</span>
	{/if}
{/snippet}

{#snippet flagsCell(c: Collection)}
	<div class="flex flex-wrap gap-1">
		{#if c.localized}<Badge variant="outline">i18n</Badge>{/if}
		{#if c.draftPublish}<Badge variant="outline">draft</Badge>{/if}
		{#if c.system}<Badge>system</Badge>{/if}
	</div>
{/snippet}

{#snippet actionsCell(c: Collection)}
	<div class="flex items-center justify-end gap-1">
		<Button
			href={resolve('/(admin)/admin/content/[collection]', {
				collection: c.apiId,
			})}
			variant="ghost"
			size="sm"
		>
			Manage
		</Button>
		{#if !c.system}
			{#if confirmFor === c.apiId}
				<form
					method="POST"
					action="?/deleteCollection"
					use:enhance={() => {
						return async ({ update }) => {
							confirmFor = null;
							await update();
						};
					}}
					class="flex items-center gap-1"
				>
					<input type="hidden" name="apiId" value={c.apiId} />
					<Input
						name="confirm"
						placeholder={c.apiId}
						class="h-8 w-28 text-xs"
						required
					/>
					<Button type="submit" variant="destructive" size="sm">Confirm</Button>
				</form>
			{:else}
				<Button
					variant="ghost"
					size="sm"
					class="text-destructive"
					onclick={() => (confirmFor = c.apiId)}
				>
					Delete
				</Button>
			{/if}
		{/if}
	</div>
{/snippet}

<PageShell width="wide">
	<PageHeader
		title="Content types"
		description="Define content types as data — no migration, no deploy."
		icon={Database}
	/>

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

	<section class="mb-6 space-y-4 rounded-lg border border-border p-4">
		<h2
			class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
		>
			New content type
		</h2>
		<form
			method="POST"
			action="?/createCollection"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: true });
					submitting = false;
				};
			}}
			class="space-y-3"
		>
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1">
					<Label for="apiId" class="text-xs">API id</Label>
					<Input
						id="apiId"
						name="apiId"
						required
						maxlength={63}
						placeholder="product_line"
					/>
					<p class="text-xs text-muted-foreground">
						Lowercase, single underscores. Immutable once created.
					</p>
				</div>
				<div class="space-y-1">
					<Label for="kind" class="text-xs">Kind</Label>
					<select
						id="kind"
						name="kind"
						class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
					>
						<option value="collection">Collection — many entries</option>
						<option value="single">Single — exactly one entry</option>
						<option value="component">Component — nested block only</option>
					</select>
				</div>
			</div>

			<div class="space-y-1">
				<Label for="description" class="text-xs">Description (internal)</Label>
				<Input id="description" name="description" maxlength={200} />
			</div>

			<div class="flex gap-6 text-sm">
				<label class="flex items-center gap-2">
					<input type="hidden" name="localized" value="false" />
					<input
						type="checkbox"
						name="localized"
						value="true"
						checked
						class="h-4 w-4 rounded border-input"
					/>
					Localized
				</label>
				<label class="flex items-center gap-2">
					<input type="hidden" name="draftPublish" value="false" />
					<input
						type="checkbox"
						name="draftPublish"
						value="true"
						checked
						class="h-4 w-4 rounded border-input"
					/>
					Draft / publish workflow
				</label>
			</div>

			<div class="flex justify-end">
				<Button type="submit" disabled={submitting}>
					<Plus class="mr-2 h-4 w-4" />
					{submitting ? 'Creating…' : 'Create'}
				</Button>
			</div>
		</form>
	</section>

	<section>
		<div class="mb-3 flex items-baseline justify-between">
			<h2
				class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
			>
				Existing ({data.collections.length})
			</h2>
			<p class="text-xs text-muted-foreground">
				Promoted columns: {data.promotionBudget.used} / {data.promotionBudget
					.max}
				{#if data.promotionBudget.remaining <= 5}
					<span class="ml-1 text-amber-600">— near D1's column limit</span>
				{/if}
			</p>
		</div>

		<DataTable
			columns={columns}
			rows={data.collections}
			getKey={(c) => c.id}
			caption="Content types"
		>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">
					No content types yet. Create one above.
				</p>
			{/snippet}
		</DataTable>
	</section>
</PageShell>
