<script lang="ts">
	import { enhance } from '$app/forms';
	import { Boxes } from 'lucide-svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let createOpen = $state(false);

	const statusClass = (s: string) =>
		s === 'active'
			? 'bg-green-100 text-green-800'
			: s === 'archived'
				? 'bg-neutral-100 text-neutral-700'
				: 'bg-amber-100 text-amber-800';
</script>

<svelte:head><title>Collections — Khao Pad CMS</title></svelte:head>

<div class="space-y-4 p-6">
	<header class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-3">
			<Boxes class="h-6 w-6 text-muted-foreground" />
			<div>
				<h1 class="text-2xl font-semibold">Collections</h1>
				<p class="text-sm text-muted-foreground">Group products for storefront browsing.</p>
			</div>
		</div>
		<button
			type="button"
			onclick={() => (createOpen = !createOpen)}
			class="h-11 rounded-md bg-primary px-4 text-sm text-primary-foreground sm:h-9"
		>
			{createOpen ? 'Cancel' : 'New collection'}
		</button>
	</header>

	{#if form?.error}
		<div class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
			{form.error}
		</div>
	{:else if form?.success}
		<div class="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
			Collection created.
		</div>
	{/if}

	{#if createOpen}
		<form
			method="POST"
			action="?/create"
			use:enhance={() => async ({ update }) => {
				await update();
				createOpen = false;
			}}
			class="space-y-4 rounded-lg border p-4"
		>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="titleEn" class="text-sm font-medium">Title (English)</label>
					<input
						id="titleEn"
						name="titleEn"
						required
						value={form?.values?.titleEn ?? ''}
						class="mt-1 h-11 w-full rounded-md border px-3 text-base sm:h-9 sm:text-sm"
					/>
					<p class="mt-1 text-xs text-muted-foreground">
						Required — the slug is derived from this.
					</p>
				</div>
				<div>
					<label for="titleTh" class="text-sm font-medium">Title (Thai)</label>
					<input
						id="titleTh"
						name="titleTh"
						value={form?.values?.titleTh ?? ''}
						class="mt-1 h-11 w-full rounded-md border px-3 text-base sm:h-9 sm:text-sm"
					/>
				</div>
				<div>
					<label for="slug" class="text-sm font-medium">Slug</label>
					<input
						id="slug"
						name="slug"
						placeholder="auto from English title"
						value={form?.values?.slug ?? ''}
						class="mt-1 h-11 w-full rounded-md border px-3 font-mono text-base sm:h-9 sm:text-sm"
					/>
				</div>
				<div>
					<label for="status" class="text-sm font-medium">Status</label>
					<select
						id="status"
						name="status"
						class="mt-1 h-11 w-full rounded-md border px-3 text-base sm:h-9 sm:text-sm"
					>
						<option value="draft">Draft</option>
						<option value="active">Active</option>
					</select>
				</div>
			</div>

			{#if data.products.length > 0}
				<fieldset>
					<legend class="text-sm font-medium">Products</legend>
					<p class="mb-2 text-xs text-muted-foreground">
						Optional — products can be added now or later.
					</p>
					<div class="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
						{#each data.products as p (p.id)}
							<label class="flex items-center gap-2 text-sm">
								<input type="checkbox" name="productIds" value={p.id} />
								<span>{p.title || p.slug}</span>
							</label>
						{/each}
					</div>
				</fieldset>
			{:else}
				<p class="text-xs text-muted-foreground">
					No products yet — create some first to populate a collection.
				</p>
			{/if}

			<button
				type="submit"
				class="h-11 rounded-md bg-primary px-4 text-sm text-primary-foreground sm:h-9"
			>
				Create collection
			</button>
		</form>
	{/if}

	{#if data.collections.length === 0}
		<div class="rounded-lg border border-dashed border-border p-8 text-center">
			<p class="text-sm text-muted-foreground">
				No collections yet. Create one to group products on the storefront.
			</p>
		</div>
	{:else}
		<div class="overflow-x-auto rounded-lg border border-border">
			<table class="w-full text-sm">
				<thead class="bg-muted">
					<tr>
						<th class="px-4 py-3 text-left font-medium">Title</th>
						<th class="px-4 py-3 text-left font-medium">Slug</th>
						<th class="px-4 py-3 text-left font-medium">Status</th>
						<th class="px-4 py-3 text-right font-medium">Products</th>
					</tr>
				</thead>
				<tbody>
					{#each data.collections as c (c.id)}
						<tr class="border-t border-border">
							<td class="px-4 py-3 font-medium">{c.title || '(untitled)'}</td>
							<td class="px-4 py-3 font-mono text-xs text-muted-foreground">{c.slug}</td>
							<td class="px-4 py-3">
								<span class="rounded px-2 py-0.5 text-xs {statusClass(c.status)}">
									{c.status}
								</span>
							</td>
							<td class="px-4 py-3 text-right tabular-nums">{c.productCount}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
