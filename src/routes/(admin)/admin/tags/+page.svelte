<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import { Tags } from 'lucide-svelte';

	let { data, form } = $props();

	let editingId = $state<string | null>(null);
	let createOpen = $state(false);

	let createNameEn = $state(form?.values?.nameEn ?? '');
	let createNameTh = $state(form?.values?.nameTh ?? '');
	let createSlug = $state(form?.values?.slugInput ?? '');

	const derivedSlug = $derived(slugify(createSlug || createNameEn));

	const canManage = Boolean(
		data.user && ['super_admin', 'admin', 'editor'].includes(data.user.role)
	);
</script>

<svelte:head>
	<title>{m.cms_tags()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader title={m.cms_tags()} description={m.cms_tags_help()} icon={Tags}>
		{#snippet actions()}
			{#if canManage}
				<Button type="button" onclick={() => (createOpen = !createOpen)}>
					{createOpen ? m.cms_cancel() : m.cms_new_tag()}
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{form.error}</div>
		{/if}

		{#if createOpen && canManage}
			<form
				method="POST"
				action="?/create"
				use:enhance={() => async ({ result, update }) => {
					await update();
					if (result.type === 'success') {
						createOpen = false;
						createNameEn = '';
						createNameTh = '';
						createSlug = '';
					}
				}}
				class="space-y-3 rounded-lg border border-border bg-card p-4"
			>
				<h2 class="font-semibold">{m.cms_new_tag()}</h2>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<label class="block">
						<span class="text-sm font-medium">{m.cms_name_en()}</span>
						<input
							name="name_en"
							bind:value={createNameEn}
							required
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</label>
					<label class="block">
						<span class="text-sm font-medium">{m.cms_name_th()}</span>
						<input
							name="name_th"
							bind:value={createNameTh}
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</label>
					<label class="block">
						<span class="text-sm font-medium">{m.cms_slug()}</span>
						<input
							name="slug"
							bind:value={createSlug}
							placeholder={derivedSlug}
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
						/>
					</label>
				</div>
				<div class="flex justify-end">
					<Button type="submit">{m.cms_create()}</Button>
				</div>
			</form>
		{/if}

		{#if data.items.length === 0}
			<p class="text-sm text-muted-foreground">{m.cms_tags_empty()}</p>
		{:else}
			<!--
				Left as a raw table: an editing row replaces the whole row with a
				single colspan cell holding a form, which DataTable's per-column
				cell model cannot express.
			-->
			<div class="overflow-x-auto rounded-lg border border-border">
				<table class="w-full text-sm">
					<thead class="bg-muted">
						<tr>
							<th class="px-4 py-3 text-left font-medium">{m.cms_name_en()}</th>
							<th class="px-4 py-3 text-left font-medium">{m.cms_name_th()}</th>
							<th class="px-4 py-3 text-left font-medium">{m.cms_slug()}</th>
							{#if canManage}
								<th class="px-4 py-3 text-right font-medium">{m.col_actions()}</th>
							{/if}
						</tr>
					</thead>
					<tbody>
						{#each data.items as tag (tag.id)}
							{@const isEditing = editingId === tag.id}
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
											<input type="hidden" name="id" value={tag.id} />
											<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
												<label class="block">
													<span class="text-xs font-medium">{m.cms_name_en()}</span>
													<input
														name="name_en"
														value={tag.localizations.en?.name ?? ''}
														required
														class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
													/>
												</label>
												<label class="block">
													<span class="text-xs font-medium">{m.cms_name_th()}</span>
													<input
														name="name_th"
														value={tag.localizations.th?.name ?? ''}
														class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
													/>
												</label>
												<label class="block">
													<span class="text-xs font-medium">{m.cms_slug()}</span>
													<input
														name="slug"
														value={tag.slug}
														class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
													/>
												</label>
											</div>
											<div class="flex items-center gap-2">
												<Button type="submit" size="sm">{m.cms_save()}</Button>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onclick={() => (editingId = null)}
												>
													{m.cms_cancel()}
												</Button>
											</div>
										</form>
									</td>
								{:else}
									<td class="px-4 py-3 font-medium">{tag.localizations.en?.name ?? '—'}</td>
									<td class="px-4 py-3 text-muted-foreground">
										{tag.localizations.th?.name ?? '—'}
									</td>
									<td class="px-4 py-3 font-mono text-xs text-muted-foreground">{tag.slug}</td>
									{#if canManage}
										<td class="px-4 py-3 text-right">
											<div class="flex items-center justify-end gap-1">
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onclick={() => (editingId = tag.id)}
												>
													{m.cms_edit()}
												</Button>
												<form
													method="POST"
													action="?/delete"
													use:enhance={({ cancel }) => {
														if (!confirm(m.cms_tag_delete_confirm())) {
															cancel();
															return;
														}
														return async ({ update }) => update();
													}}
													class="inline"
												>
													<input type="hidden" name="id" value={tag.id} />
													<Button type="submit" variant="ghost" size="sm" class="text-destructive">
														{m.cms_delete()}
													</Button>
												</form>
											</div>
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
</PageShell>
