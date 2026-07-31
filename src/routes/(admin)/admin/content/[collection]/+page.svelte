<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { ArrowLeft, Plus, Star } from 'lucide-svelte';
	import { Badge, Button, Input, Label } from '$lib/components/ui';
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
</script>

<div class="max-w-5xl space-y-6 p-6">
	<header class="space-y-2">
		<Button
			href={resolve('/(admin)/admin/content')}
			variant="ghost"
			size="sm"
			class="-ml-2"
		>
			<ArrowLeft class="mr-1 h-4 w-4" /> Content types
		</Button>
		<div class="flex items-center gap-3">
			<h1 class="font-mono text-2xl font-semibold">{c.apiId}</h1>
			<Badge variant="outline">{c.kind}</Badge>
			{#if c.localized}<Badge variant="outline">i18n</Badge>{/if}
		</div>
	</header>

	{#if form?.error}
		<div
			class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
		>
			{form.error}
		</div>
	{/if}
	{#if form?.success && form.message}
		<div
			class="rounded-md border border-green-600/50 bg-green-600/10 p-3 text-sm text-green-700"
		>
			{form.message}
		</div>
	{/if}

	<!-- ── Fields ───────────────────────────────────────────── -->
	<section class="space-y-3">
		<h2
			class="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
		>
			Fields ({c.fields.length})
		</h2>

		{#if c.fields.length > 0}
			<div class="overflow-x-auto rounded-lg border border-border">
				<table class="w-full text-sm">
					<thead
						class="bg-muted/50 text-left text-xs uppercase text-muted-foreground"
					>
						<tr>
							<th class="px-4 py-2">API id</th>
							<th class="px-4 py-2">Type</th>
							<th class="px-4 py-2">Flags</th>
							{#if data.canEditSchema}<th class="w-20 px-4 py-2"></th>{/if}
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each c.fields as f (f.id)}
							<tr>
								<td class="px-4 py-2.5">
									<code class="font-mono">{f.apiId}</code>
								</td>
								<td class="px-4 py-2.5 text-xs text-muted-foreground">
									{f.type}
								</td>
								<td class="px-4 py-2.5">
									<div class="flex flex-wrap gap-1">
										{#if f.required}<Badge variant="outline">required</Badge
											>{/if}
										{#if f.localized}<Badge variant="outline">i18n</Badge>{/if}
										{#if f.unique}<Badge variant="outline">unique</Badge>{/if}
										{#if f.promoted}
											<Badge title="Indexed generated column">
												<Star class="mr-1 h-3 w-3" />indexed
											</Badge>
										{/if}
									</div>
								</td>
								{#if data.canEditSchema}
									<td class="px-4 py-2.5 text-right">
										<form method="POST" action="?/removeField" use:enhance>
											<input type="hidden" name="apiId" value={f.apiId} />
											<Button
												type="submit"
												variant="ghost"
												size="sm"
												class="text-destructive"
											>
												Remove
											</Button>
										</form>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
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

		{#if data.entries.length === 0}
			<div
				class="rounded-lg border border-dashed border-border p-8 text-center"
			>
				<p class="text-sm text-muted-foreground">
					{c.fields.length === 0
						? 'Add a field first, then create entries.'
						: 'No entries yet.'}
				</p>
			</div>
		{:else}
			<div class="overflow-x-auto rounded-lg border border-border">
				<table class="w-full text-sm">
					<thead
						class="bg-muted/50 text-left text-xs uppercase text-muted-foreground"
					>
						<tr>
							<th class="px-4 py-2">Slug</th>
							<th class="px-4 py-2">Status</th>
							<th class="px-4 py-2">Updated</th>
							<th class="w-32 px-4 py-2"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each data.entries as e (e.id)}
							<tr>
								<td class="px-4 py-2.5">
									<code class="font-mono text-xs">
										{e.slug ?? e.id}
									</code>
								</td>
								<td class="px-4 py-2.5">
									<Badge variant={e.status === 'published' ? 'default' : 'outline'}>
										{e.status}
									</Badge>
								</td>
								<td class="px-4 py-2.5 text-xs text-muted-foreground">
									{e.updatedAt.slice(0, 16).replace('T', ' ')}
								</td>
								<td class="px-4 py-2.5">
									<div class="flex items-center justify-end gap-1">
										<Button
											href={resolve(
												'/(admin)/admin/content/[collection]/[id]',
												{ collection: c.apiId, id: e.id },
											)}
											variant="ghost"
											size="sm"
										>
											Edit
										</Button>
										<form method="POST" action="?/deleteEntry" use:enhance>
											<input type="hidden" name="id" value={e.id} />
											<Button
												type="submit"
												variant="ghost"
												size="sm"
												class="text-destructive"
											>
												Delete
											</Button>
										</form>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if data.entries.length === data.entryPageSize}
				<p class="text-xs text-muted-foreground">
					Showing the {data.entryPageSize} most recently updated. Paging lands
					with the list-view work.
				</p>
			{/if}
		{/if}
	</section>
</div>
