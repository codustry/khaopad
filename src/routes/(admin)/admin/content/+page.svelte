<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Database, Plus, Layers, Box } from 'lucide-svelte';
	import { Badge, Button, Input, Label } from '$lib/components/ui';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
	let confirmFor = $state<string | null>(null);

	const KIND_ICON = { collection: Layers, single: Box, component: Box };
</script>

<div class="max-w-5xl space-y-6 p-6">
	<header class="flex items-center gap-3">
		<Database class="h-6 w-6 text-muted-foreground" />
		<div>
			<h1 class="text-2xl font-semibold">Content types</h1>
			<p class="text-sm text-muted-foreground">
				Define content types as data — no migration, no deploy.
			</p>
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

	<section class="space-y-4 rounded-lg border border-border p-4">
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

		{#if data.collections.length === 0}
			<div
				class="rounded-lg border border-dashed border-border p-8 text-center"
			>
				<p class="text-sm text-muted-foreground">
					No content types yet. Create one above.
				</p>
			</div>
		{:else}
			<div class="overflow-hidden rounded-lg border border-border">
				<table class="w-full text-sm">
					<thead
						class="bg-muted/50 text-left text-xs uppercase text-muted-foreground"
					>
						<tr>
							<th class="px-4 py-2">API id</th>
							<th class="px-4 py-2">Kind</th>
							<th class="px-4 py-2 text-right">Fields</th>
							<th class="px-4 py-2 text-right">Entries</th>
							<th class="px-4 py-2">Flags</th>
							<th class="w-40 px-4 py-2"></th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border">
						{#each data.collections as c (c.id)}
							{@const Icon = KIND_ICON[c.kind] ?? Layers}
							<tr>
								<td class="px-4 py-3">
									<div class="flex items-center gap-2">
										<Icon class="h-4 w-4 text-muted-foreground" />
										<code class="font-mono font-medium">{c.apiId}</code>
									</div>
									{#if c.description}
										<div class="mt-0.5 text-xs text-muted-foreground">
											{c.description}
										</div>
									{/if}
								</td>
								<td class="px-4 py-3 text-xs text-muted-foreground">
									{c.kind}
								</td>
								<td class="px-4 py-3 text-right tabular-nums">
									{c.fieldCount}
									{#if c.promotedCount > 0}
										<span
											class="text-muted-foreground"
											title="{c.promotedCount} promoted to indexed columns"
										>
											({c.promotedCount}★)
										</span>
									{/if}
								</td>
								<td class="px-4 py-3 text-right tabular-nums">
									{c.entryCount}
								</td>
								<td class="px-4 py-3">
									<div class="flex flex-wrap gap-1">
										{#if c.localized}<Badge variant="outline">i18n</Badge>{/if}
										{#if c.draftPublish}<Badge variant="outline">draft</Badge
											>{/if}
										{#if c.system}<Badge>system</Badge>{/if}
									</div>
								</td>
								<td class="px-4 py-3">
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
													<Button
														type="submit"
														variant="ghost"
														size="sm"
														class="text-destructive"
													>
														Confirm
													</Button>
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
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
