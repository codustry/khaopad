<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';

	let { data, form } = $props();

	let editingId = $state<string | null>(null);
	let createOpen = $state(false);

	let createNameEn = $state(form?.values?.nameEn ?? '');
	let createNameTh = $state(form?.values?.nameTh ?? '');
	let createDescEn = $state(form?.values?.descEn ?? '');
	let createDescTh = $state(form?.values?.descTh ?? '');
	let createSlug = $state(form?.values?.slugInput ?? '');

	const derivedSlug = $derived(slugify(createSlug || createNameEn));

	const canManage = Boolean(
		data.user && ['super_admin', 'admin', 'editor'].includes(data.user.role)
	);
</script>

<svelte:head>
	<title>{m.cms_categories()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_categories()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_categories_help()}</p>
		</div>
		{#if canManage}
			<button
				type="button"
				class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
				onclick={() => (createOpen = !createOpen)}
			>
				{createOpen ? m.cms_cancel() : m.cms_new_category()}
			</button>
		{/if}
	</header>

	{#if form?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">{form.error}</div>
	{/if}

	{#if createOpen && canManage}
		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				return async ({ result, update }) => {
					await update();
					if (result.type === 'success') {
						createOpen = false;
						createNameEn = '';
						createNameTh = '';
						createDescEn = '';
						createDescTh = '';
						createSlug = '';
					}
				};
			}}
			class="border border-border rounded-lg p-4 space-y-3 bg-card"
		>
			<h2 class="font-semibold">{m.cms_new_category()}</h2>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-sm font-medium">{m.cms_name_en()}</span>
					<input
						name="name_en"
						bind:value={createNameEn}
						required
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-sm font-medium">{m.cms_name_th()}</span>
					<input
						name="name_th"
						bind:value={createNameTh}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-sm font-medium">{m.cms_description_en()}</span>
					<input
						name="description_en"
						bind:value={createDescEn}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-sm font-medium">{m.cms_description_th()}</span>
					<input
						name="description_th"
						bind:value={createDescTh}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block sm:col-span-2">
					<span class="text-sm font-medium">{m.cms_slug()}</span>
					<input
						name="slug"
						bind:value={createSlug}
						placeholder={derivedSlug}
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
					/>
					<span class="text-xs text-muted-foreground">{m.cms_slug_help()}</span>
				</label>
			</div>
			<div class="flex justify-end">
				<button
					type="submit"
					class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
				>
					{m.cms_create()}
				</button>
			</div>
		</form>
	{/if}

	{#if data.items.length === 0}
		<p class="text-sm text-muted-foreground">{m.cms_categories_empty()}</p>
	{:else}
		<div class="border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted">
					<tr>
						<th class="text-left px-4 py-3 font-medium">{m.cms_name_en()}</th>
						<th class="text-left px-4 py-3 font-medium">{m.cms_name_th()}</th>
						<th class="text-left px-4 py-3 font-medium">{m.cms_slug()}</th>
						{#if canManage}
							<th class="text-right px-4 py-3 font-medium">{m.col_actions()}</th>
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each data.items as cat (cat.id)}
						{@const isEditing = editingId === cat.id}
						<tr class="border-t border-border align-top">
							{#if isEditing}
								<td colspan={canManage ? 4 : 3} class="px-4 py-3">
									<form
										method="POST"
										action="?/update"
										use:enhance={() => async ({ result, update }) => {
											await update();
											if (result.type === 'success') editingId = null;
										}}
										class="space-y-3"
									>
										<input type="hidden" name="id" value={cat.id} />
										<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
											<label class="block">
												<span class="text-xs font-medium">{m.cms_name_en()}</span>
												<input
													name="name_en"
													value={cat.localizations.en?.name ?? ''}
													required
													class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
												/>
											</label>
											<label class="block">
												<span class="text-xs font-medium">{m.cms_name_th()}</span>
												<input
													name="name_th"
													value={cat.localizations.th?.name ?? ''}
													class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
												/>
											</label>
											<label class="block">
												<span class="text-xs font-medium">{m.cms_description_en()}</span>
												<input
													name="description_en"
													value={cat.localizations.en?.description ?? ''}
													class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
												/>
											</label>
											<label class="block">
												<span class="text-xs font-medium">{m.cms_description_th()}</span>
												<input
													name="description_th"
													value={cat.localizations.th?.description ?? ''}
													class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
												/>
											</label>
											<label class="block sm:col-span-2">
												<span class="text-xs font-medium">{m.cms_slug()}</span>
												<input
													name="slug"
													value={cat.slug}
													class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
												/>
											</label>
										</div>
										<div class="flex items-center gap-2">
											<button
												type="submit"
												class="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs hover:opacity-90"
											>
												{m.cms_save()}
											</button>
											<button
												type="button"
												onclick={() => (editingId = null)}
												class="px-3 py-1.5 text-muted-foreground hover:underline text-xs"
											>
												{m.cms_cancel()}
											</button>
										</div>
									</form>
								</td>
							{:else}
								<td class="px-4 py-3 font-medium">{cat.localizations.en?.name ?? '—'}</td>
								<td class="px-4 py-3 text-muted-foreground">
									{cat.localizations.th?.name ?? '—'}
								</td>
								<td class="px-4 py-3 font-mono text-xs text-muted-foreground">{cat.slug}</td>
								{#if canManage}
									<td class="px-4 py-3 text-right space-x-3">
										<button
											type="button"
											class="text-xs hover:underline"
											onclick={() => (editingId = cat.id)}
										>
											{m.cms_edit()}
										</button>
										<form
											method="POST"
											action="?/delete"
											use:enhance={({ cancel }) => {
												if (!confirm(m.cms_category_delete_confirm())) {
													cancel();
													return;
												}
												return async ({ update }) => update();
											}}
											class="inline"
										>
											<input type="hidden" name="id" value={cat.id} />
											<button type="submit" class="text-destructive hover:underline text-xs">
												{m.cms_delete()}
											</button>
										</form>
									</td>
								{/if}
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
