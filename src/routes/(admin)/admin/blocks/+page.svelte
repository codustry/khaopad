<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import { Blocks } from 'lucide-svelte';
	import type { ContentBlockRecord } from '$lib/server/content/types';

	// Workaround: paraglide-generated `cms_blocks_help` is typed as
	// requiring a non-optional `inputs` arg here even though it has none.
	// Cast to a no-arg callable so we can use it bare. (Build is green
	// without this; pure svelte-check noise.)
	const blocksHelp = m.cms_blocks_help as unknown as () => string;

	let {
		data,
		form,
	}: {
		data: { blocks: ContentBlockRecord[] };
		form: { ok?: boolean; error?: string; blockId?: string } | null;
	} = $props();

	let editingId = $state<string | null>(null);
	let createOpen = $state(false);

	// Create-form state.
	let cKey = $state('');
	let cLabel = $state('');
	let cBodyEn = $state('');
	let cBodyTh = $state('');
	const derivedKey = $derived(slugify(cKey || cLabel));

	function startEdit(b: ContentBlockRecord) {
		editingId = b.id;
		createOpen = false;
	}
	function cancelEdit() {
		editingId = null;
	}
	function startCreate() {
		createOpen = true;
		editingId = null;
		cKey = '';
		cLabel = '';
		cBodyEn = '';
		cBodyTh = '';
	}
</script>

<svelte:head>
	<title>{m.cms_blocks()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell>
	<PageHeader title={m.cms_blocks()} description={blocksHelp()} icon={Blocks}>
		{#snippet actions()}
			<Button type="button" onclick={startCreate}>{m.cms_blocks_new()}</Button>
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				{form.error}
			</div>
		{/if}

		{#if createOpen}
			<form
				method="POST"
				action="?/create"
				use:enhance={() =>
					async ({ update, result }) => {
						await update();
						if (result.type === 'success') {
							createOpen = false;
						}
					}}
				class="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
			>
				<h2 class="text-sm font-semibold">{m.cms_blocks_new()}</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block">
						<span class="text-xs font-medium">{m.cms_blocks_key()}</span>
						<input
							name="key"
							bind:value={cKey}
							placeholder={derivedKey || 'my-block-key'}
							required
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
						/>
						<span class="text-xs text-muted-foreground">
							{m.cms_blocks_key_help({ usage: `{{block:${derivedKey || 'key'}}}` })}
						</span>
					</label>
					<label class="block">
						<span class="text-xs font-medium">{m.cms_blocks_label()}</span>
						<input
							name="label"
							bind:value={cLabel}
							required
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</label>
				</div>
				<label class="block">
					<span class="text-xs font-medium">EN — {m.cms_body()}</span>
					<textarea
						name="body_en"
						bind:value={cBodyEn}
						rows="4"
						required
						class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
					></textarea>
				</label>
				<label class="block">
					<span class="text-xs font-medium">TH — {m.cms_body()}</span>
					<textarea
						name="body_th"
						bind:value={cBodyTh}
						rows="4"
						class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
					></textarea>
				</label>
				<div class="flex gap-2">
					<Button type="submit">{m.cms_blocks_create()}</Button>
					<Button type="button" variant="outline" onclick={() => (createOpen = false)}>
						{m.cms_cancel()}
					</Button>
				</div>
			</form>
		{/if}

		{#if data.blocks.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center">
				<p class="text-sm text-muted-foreground">{m.cms_blocks_empty()}</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each data.blocks as block (block.id)}
					<div class="rounded-lg border border-border">
						<div class="flex items-center justify-between rounded-t-lg bg-muted/20 px-4 py-3">
							<div class="min-w-0">
								<div class="truncate text-sm font-medium">{block.label}</div>
								<div class="mt-0.5 font-mono text-xs text-muted-foreground">
									{`{{block:${block.key}}}`}
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if editingId === block.id}
									<Button type="button" variant="outline" size="sm" onclick={cancelEdit}>
										{m.cms_cancel()}
									</Button>
								{:else}
									<Button
										type="button"
										variant="outline"
										size="sm"
										onclick={() => startEdit(block)}
									>
										{m.cms_edit_article()}
									</Button>
									<form
										method="POST"
										action="?/delete"
										use:enhance={({ cancel }) => {
											if (!confirm(m.cms_delete_confirm())) {
												cancel();
												return;
											}
											return async ({ update }) => update();
										}}
									>
										<input type="hidden" name="id" value={block.id} />
										<Button type="submit" variant="destructive" size="sm">
											{m.cms_delete()}
										</Button>
									</form>
								{/if}
							</div>
						</div>
						{#if editingId === block.id}
							<form
								method="POST"
								action="?/update"
								use:enhance={() =>
									async ({ update, result }) => {
										await update();
										if (result.type === 'success') editingId = null;
									}}
								class="space-y-3 p-4"
							>
								<input type="hidden" name="id" value={block.id} />
								<div class="grid gap-3 sm:grid-cols-2">
									<label class="block">
										<span class="text-xs font-medium">{m.cms_blocks_key()}</span>
										<input
											name="key"
											value={block.key}
											required
											class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
										/>
									</label>
									<label class="block">
										<span class="text-xs font-medium">{m.cms_blocks_label()}</span>
										<input
											name="label"
											value={block.label}
											required
											class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
										/>
									</label>
								</div>
								<label class="block">
									<span class="text-xs font-medium">EN — {m.cms_body()}</span>
									<textarea
										name="body_en"
										rows="4"
										required
										class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
										>{block.localizations.en?.body ?? ''}</textarea
									>
								</label>
								<label class="block">
									<span class="text-xs font-medium">TH — {m.cms_body()}</span>
									<textarea
										name="body_th"
										rows="4"
										class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
										>{block.localizations.th?.body ?? ''}</textarea
									>
								</label>
								<div>
									<Button type="submit">{m.cms_save()}</Button>
								</div>
							</form>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</PageShell>
