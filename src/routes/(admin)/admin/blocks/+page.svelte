<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';
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

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_blocks()}</h1>
			<p class="text-sm text-muted-foreground">{blocksHelp()}</p>
		</div>
		<button
			type="button"
			onclick={startCreate}
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
		>
			{m.cms_blocks_new()}
		</button>
	</header>

	{#if form?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
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
			class="space-y-3 border border-border rounded-lg p-4 bg-muted/20"
		>
			<h2 class="font-semibold text-sm">{m.cms_blocks_new()}</h2>
			<div class="grid sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_blocks_key()}</span>
					<input
						name="key"
						bind:value={cKey}
						placeholder={derivedKey || 'my-block-key'}
						required
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
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
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
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
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
				></textarea>
			</label>
			<label class="block">
				<span class="text-xs font-medium">TH — {m.cms_body()}</span>
				<textarea
					name="body_th"
					bind:value={cBodyTh}
					rows="4"
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
				></textarea>
			</label>
			<div class="flex gap-2">
				<button
					type="submit"
					class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
				>
					{m.cms_blocks_create()}
				</button>
				<button
					type="button"
					onclick={() => (createOpen = false)}
					class="px-4 py-2 border border-border rounded-md text-sm hover:bg-muted"
				>
					{m.cms_cancel()}
				</button>
			</div>
		</form>
	{/if}

	{#if data.blocks.length === 0}
		<div class="border border-dashed border-border rounded-lg p-8 text-center">
			<p class="text-sm text-muted-foreground">{m.cms_blocks_empty()}</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each data.blocks as block (block.id)}
				<div class="border border-border rounded-lg overflow-hidden">
					<div class="flex items-center justify-between px-4 py-3 bg-muted/20">
						<div class="min-w-0">
							<div class="font-medium text-sm truncate">{block.label}</div>
							<div class="text-xs text-muted-foreground font-mono mt-0.5">
								{`{{block:${block.key}}}`}
							</div>
						</div>
						<div class="flex items-center gap-2">
							{#if editingId === block.id}
								<button
									type="button"
									onclick={cancelEdit}
									class="px-3 py-1.5 border border-border rounded-md text-xs hover:bg-muted"
								>
									{m.cms_cancel()}
								</button>
							{:else}
								<button
									type="button"
									onclick={() => startEdit(block)}
									class="px-3 py-1.5 border border-border rounded-md text-xs hover:bg-muted"
								>
									{m.cms_edit_article()}
								</button>
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
									<button
										type="submit"
										class="px-3 py-1.5 border border-destructive text-destructive rounded-md text-xs hover:bg-destructive/10"
									>
										{m.cms_delete()}
									</button>
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
							<div class="grid sm:grid-cols-2 gap-3">
								<label class="block">
									<span class="text-xs font-medium">{m.cms_blocks_key()}</span>
									<input
										name="key"
										value={block.key}
										required
										class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
									/>
								</label>
								<label class="block">
									<span class="text-xs font-medium">{m.cms_blocks_label()}</span>
									<input
										name="label"
										value={block.label}
										required
										class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
									/>
								</label>
							</div>
							<label class="block">
								<span class="text-xs font-medium">EN — {m.cms_body()}</span>
								<textarea
									name="body_en"
									rows="4"
									required
									class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
									>{block.localizations.en?.body ?? ''}</textarea
								>
							</label>
							<label class="block">
								<span class="text-xs font-medium">TH — {m.cms_body()}</span>
								<textarea
									name="body_th"
									rows="4"
									class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
									>{block.localizations.th?.body ?? ''}</textarea
								>
							</label>
							<div>
								<button
									type="submit"
									class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
								>
									{m.cms_save()}
								</button>
							</div>
						</form>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
