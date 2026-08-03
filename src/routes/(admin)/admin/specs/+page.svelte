<script lang="ts">
	import { enhance } from '$app/forms';
	import { Ruler, Plus, Boxes } from 'lucide-svelte';
	import { Badge, Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable } from '$lib/components/admin';
	import type { Column } from '$lib/components/admin';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
	let confirmFor = $state<string | null>(null);
	let newDataType = $state('text');

	type Attr = PageData['attributes'][number];

	const columns: Column<Attr>[] = [
		{ key: 'key', header: 'Key', cell: keyCell },
		{ key: 'dataType', header: 'Type', cell: typeCell },
		{ key: 'unit', header: 'Unit family', cell: unitCell },
		{ key: 'optionCount', header: 'Options', align: 'right', numeric: true, cell: optionsCell },
		{ key: 'families', header: 'Families', cell: familiesCell },
		{ key: 'actions', header: '', align: 'right', class: 'w-44', cell: actionsCell }
	];
</script>

{#snippet keyCell(a: Attr)}
	<code class="font-mono font-medium">{a.key}</code>
	{#if a.groupKey}
		<div class="mt-0.5 text-xs text-muted-foreground">group: {a.groupKey}</div>
	{/if}
{/snippet}

{#snippet typeCell(a: Attr)}
	<span class="text-xs text-muted-foreground">{a.dataType}</span>
{/snippet}

{#snippet unitCell(a: Attr)}
	{#if a.measureFamily}
		{a.measureFamily}
		<span class="text-xs text-muted-foreground">({a.standardUnit})</span>
	{:else}
		<span class="text-muted-foreground">—</span>
	{/if}
{/snippet}

{#snippet optionsCell(a: Attr)}
	{#if a.optionCount > 0}{a.optionCount}{:else}<span class="text-muted-foreground">—</span>{/if}
{/snippet}

{#snippet familiesCell(a: Attr)}
	{#if a.families.length > 0}
		<div class="flex flex-wrap gap-1">
			{#each a.families as f (f)}
				<Badge variant="outline">{f}</Badge>
			{/each}
		</div>
	{:else}
		<span class="text-xs text-muted-foreground">unused</span>
	{/if}
{/snippet}

{#snippet actionsCell(a: Attr)}
	{#if data.canManage}
		<div class="flex items-center justify-end gap-1">
			{#if confirmFor === a.key}
				<form
					method="POST"
					action="?/deleteAttribute"
					use:enhance={() => {
						return async ({ update }) => {
							confirmFor = null;
							await update();
						};
					}}
					class="flex items-center gap-1"
				>
					<input type="hidden" name="key" value={a.key} />
					<Input name="confirm" placeholder={a.key} class="h-8 w-28 text-xs" required />
					<Button type="submit" variant="destructive" size="sm">Confirm</Button>
				</form>
			{:else}
				<Button
					variant="ghost"
					size="sm"
					class="text-destructive"
					onclick={() => (confirmFor = a.key)}
				>
					Delete
				</Button>
			{/if}
		</div>
	{/if}
{/snippet}

<PageShell width="wide">
	<PageHeader
		title="Specs"
		description="Typed attribute definitions and product families — the schema behind datasheets, comparisons and faceting."
		icon={Ruler}
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

	{#if data.canManage}
		<section class="mb-6 space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				New attribute
			</h2>
			<form
				method="POST"
				action="?/createAttribute"
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
						<Label for="attr-key" class="text-xs">Key</Label>
						<Input id="attr-key" name="key" required maxlength={63} placeholder="flow_rate" />
						<p class="text-xs text-muted-foreground">
							Lowercase, single underscores. Shared across families.
						</p>
					</div>
					<div class="space-y-1">
						<Label for="attr-type" class="text-xs">Data type</Label>
						<select
							id="attr-type"
							name="dataType"
							bind:value={newDataType}
							class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
						>
							<option value="text">Text</option>
							<option value="number">Number</option>
							<option value="measurement">Measurement — value + unit</option>
							<option value="select">Select — one option</option>
							<option value="multiselect">Multiselect — several options</option>
							<option value="boolean">Boolean</option>
						</select>
					</div>
				</div>

				{#if newDataType === 'measurement'}
					<div class="space-y-1">
						<Label for="attr-measure" class="text-xs">Unit family</Label>
						<select
							id="attr-measure"
							name="measureFamily"
							required
							class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
						>
							{#each data.measureFamilies as f (f.key)}
								<option value={f.key}>{f.key} — stored as {f.standardUnit}</option>
							{/each}
						</select>
						<p class="text-xs text-muted-foreground">
							Values normalize to the standard unit on write, so any authored unit compares
							correctly.
						</p>
					</div>
				{/if}

				{#if newDataType === 'select' || newDataType === 'multiselect'}
					<div class="space-y-1">
						<Label for="attr-options" class="text-xs">Options</Label>
						<textarea
							id="attr-options"
							name="options"
							required
							rows="3"
							placeholder="oil_free, air_cooled, water_cooled"
							class="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
						></textarea>
						<p class="text-xs text-muted-foreground">
							Comma or newline separated option keys — lowercase, single underscores.
						</p>
					</div>
				{/if}

				<div class="grid grid-cols-3 gap-3">
					<div class="space-y-1">
						<Label for="attr-label-en" class="text-xs">Label (EN)</Label>
						<Input id="attr-label-en" name="labelEn" maxlength={200} placeholder="Flow rate" />
					</div>
					<div class="space-y-1">
						<Label for="attr-label-th" class="text-xs">Label (TH)</Label>
						<Input id="attr-label-th" name="labelTh" maxlength={200} placeholder="อัตราการไหล" />
					</div>
					<div class="space-y-1">
						<Label for="attr-group" class="text-xs">Group (optional)</Label>
						<Input id="attr-group" name="groupKey" maxlength={63} placeholder="performance" />
					</div>
				</div>

				<div class="flex justify-end">
					<Button type="submit" disabled={submitting}>
						<Plus class="mr-2 h-4 w-4" />
						{submitting ? 'Creating…' : 'Create attribute'}
					</Button>
				</div>
			</form>
		</section>
	{/if}

	<section class="mb-8">
		<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Attributes ({data.attributes.length})
		</h2>
		<DataTable {columns} rows={data.attributes} getKey={(a) => a.key} caption="Attribute definitions">
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">
					No attributes yet.{#if data.canManage} Create one above.{/if}
				</p>
			{/snippet}
		</DataTable>
	</section>

	<section class="space-y-4">
		<div class="flex items-center gap-2">
			<Boxes class="h-4 w-4 text-muted-foreground" />
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Families ({data.families.length})
			</h2>
		</div>
		<p class="text-sm text-muted-foreground">
			A family is the attribute set a product type carries — pumps and blowers declare different
			specs instead of sharing one sparse table.
		</p>

		{#if data.canManage}
			<form
				method="POST"
				action="?/createFamily"
				use:enhance={() => {
					return async ({ update }) => {
						await update({ reset: true });
					};
				}}
				class="flex flex-wrap items-end gap-3 rounded-lg border border-border p-4"
			>
				<div class="space-y-1">
					<Label for="family-key" class="text-xs">Key</Label>
					<Input id="family-key" name="key" required maxlength={63} placeholder="vacuum_pump" />
				</div>
				<div class="space-y-1">
					<Label for="family-label-en" class="text-xs">Label (EN)</Label>
					<Input id="family-label-en" name="labelEn" maxlength={200} placeholder="Vacuum pump" />
				</div>
				<div class="space-y-1">
					<Label for="family-label-th" class="text-xs">Label (TH)</Label>
					<Input id="family-label-th" name="labelTh" maxlength={200} />
				</div>
				<div class="min-w-48 flex-1 space-y-1">
					<Label for="family-desc" class="text-xs">Description (internal)</Label>
					<Input id="family-desc" name="description" maxlength={200} />
				</div>
				<Button type="submit">
					<Plus class="mr-2 h-4 w-4" />
					Create family
				</Button>
			</form>
		{/if}

		{#if data.families.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center">
				<p class="text-sm text-muted-foreground">
					No families yet.{#if data.canManage} Create one above, then add attributes to it.{/if}
				</p>
			</div>
		{/if}

		{#each data.families as family (family.key)}
			<div class="space-y-3 rounded-lg border border-border p-4">
				<div>
					<code class="font-mono text-sm font-medium">{family.key}</code>
					{#if family.description}
						<p class="mt-0.5 text-xs text-muted-foreground">{family.description}</p>
					{/if}
				</div>

				{#if family.attributes.length > 0}
					<ol class="space-y-1">
						{#each family.attributes as fa (fa.key)}
							<li class="flex flex-wrap items-center gap-2 text-sm">
								<span class="w-8 text-right text-xs tabular-nums text-muted-foreground">
									{fa.sortOrder}
								</span>
								<code class="font-mono">{fa.key}</code>
								<span class="text-xs text-muted-foreground">{fa.dataType}</span>
								{#if fa.required}<Badge variant="outline">required</Badge>{/if}
								{#if fa.isVariantAxis}<Badge>variant axis</Badge>{/if}
							</li>
						{/each}
					</ol>
				{:else}
					<p class="text-sm text-muted-foreground">No attributes declared yet.</p>
				{/if}

				{#if data.canManage}
					<form
						method="POST"
						action="?/addToFamily"
						use:enhance={() => {
							return async ({ update }) => {
								await update({ reset: true });
							};
						}}
						class="flex flex-wrap items-end gap-3 border-t border-border pt-3"
					>
						<input type="hidden" name="familyKey" value={family.key} />
						<div class="space-y-1">
							<Label for="add-attr-{family.key}" class="text-xs">Attribute</Label>
							<select
								id="add-attr-{family.key}"
								name="attributeKey"
								required
								class="rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
							>
								{#each data.attributeKeys as key (key)}
									<option value={key}>{key}</option>
								{/each}
							</select>
						</div>
						<div class="space-y-1">
							<Label for="add-sort-{family.key}" class="text-xs">Sort order</Label>
							<Input
								id="add-sort-{family.key}"
								name="sortOrder"
								type="number"
								value="0"
								class="w-24"
							/>
						</div>
						<label class="flex items-center gap-2 pb-2 text-sm">
							<input type="checkbox" name="required" value="true" class="h-4 w-4 rounded border-input" />
							Required
						</label>
						<label class="flex items-center gap-2 pb-2 text-sm">
							<input
								type="checkbox"
								name="isVariantAxis"
								value="true"
								class="h-4 w-4 rounded border-input"
							/>
							Variant axis
						</label>
						<Button type="submit" variant="outline" size="sm" disabled={data.attributeKeys.length === 0}>
							<Plus class="mr-2 h-4 w-4" />
							Add
						</Button>
					</form>
				{/if}
			</div>
		{/each}
	</section>
</PageShell>
