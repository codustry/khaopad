<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui';
	import type { WebhookEvent, WebhookRecord } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: { webhooks: WebhookRecord[]; knownEvents: WebhookEvent[] };
		form: { ok?: boolean; error?: string; webhookId?: string } | null;
	} = $props();

	let createOpen = $state(false);
	let editingId = $state<string | null>(null);

	function fmt(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	function startCreate() {
		createOpen = true;
		editingId = null;
	}
	function startEdit(id: string) {
		editingId = id;
		createOpen = false;
	}
</script>

<svelte:head>
	<title>{m.cms_webhooks()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_webhooks()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_webhooks_help()}</p>
		</div>
		<button
			type="button"
			onclick={startCreate}
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
		>
			{m.cms_webhooks_new()}
		</button>
	</header>

	{#if form?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
			{form.error}
		</div>
	{/if}

	{#if form?.ok && form.webhookId}
		<div class="rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 px-4 py-3 text-sm">
			<p class="font-medium text-emerald-900 dark:text-emerald-100">
				{m.cms_webhooks_created()}
			</p>
			<p class="mt-1 text-xs text-emerald-800 dark:text-emerald-200">
				{m.cms_webhooks_secret_hint()}
			</p>
		</div>
	{/if}

	{#if createOpen}
		<form
			method="POST"
			action="?/create"
			use:enhance={() =>
				async ({ update, result }) => {
					await update();
					if (result.type === 'success') createOpen = false;
				}}
			class="space-y-4 border border-border rounded-lg p-4 bg-muted/20"
		>
			<h2 class="font-semibold">{m.cms_webhooks_new()}</h2>
			<div class="grid sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_webhooks_label()}</span>
					<input
						name="label"
						required
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.cms_webhooks_url()}</span>
					<input
						name="url"
						type="url"
						required
						placeholder="https://example.com/hook"
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
					/>
				</label>
			</div>
			<fieldset class="block">
				<legend class="text-xs font-medium mb-1">{m.cms_webhooks_events()}</legend>
				<div class="flex flex-wrap gap-2">
					{#each data.knownEvents as event (event)}
						<label class="inline-flex items-center gap-1.5 px-2 py-1 border border-input rounded-md text-xs">
							<input type="checkbox" name="events" value={event} class="h-3.5 w-3.5" />
							<code>{event}</code>
						</label>
					{/each}
				</div>
			</fieldset>
			<button
				type="submit"
				class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm"
			>
				{m.cms_webhooks_create()}
			</button>
		</form>
	{/if}

	{#if data.webhooks.length === 0}
		<div class="border border-dashed border-border rounded-lg p-8 text-center">
			<p class="text-sm text-muted-foreground">{m.cms_webhooks_empty()}</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each data.webhooks as wh (wh.id)}
				<div class="border border-border rounded-md overflow-hidden">
					<div class="flex items-center gap-3 px-4 py-3 bg-muted/20">
						<Badge variant={wh.enabled ? 'default' : 'secondary'}>
							{wh.enabled ? m.cms_webhooks_enabled() : m.cms_webhooks_disabled()}
						</Badge>
						<div class="flex-1 min-w-0">
							<div class="font-medium text-sm truncate">{wh.label}</div>
							<code class="text-xs text-muted-foreground font-mono truncate block">
								{wh.url}
							</code>
						</div>
						<div class="flex items-center gap-2">
							<button
								type="button"
								onclick={() => (editingId === wh.id ? (editingId = null) : startEdit(wh.id))}
								class="px-2.5 py-1 border border-border rounded-md text-xs hover:bg-muted"
							>
								{editingId === wh.id ? m.cms_cancel() : m.cms_edit_article()}
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
								<input type="hidden" name="id" value={wh.id} />
								<button
									type="submit"
									class="px-2.5 py-1 border border-destructive text-destructive rounded-md text-xs hover:bg-destructive/10"
								>
									{m.cms_delete()}
								</button>
							</form>
						</div>
					</div>
					<div class="px-4 py-2.5 bg-background flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span>{m.cms_webhooks_subscribed()}:</span>
						{#each wh.events as event (event)}
							<code class="px-1.5 py-0.5 bg-muted rounded">{event}</code>
						{/each}
						<span class="ml-auto">{fmt(wh.createdAt)}</span>
					</div>
					{#if editingId === wh.id}
						<form
							method="POST"
							action="?/update"
							use:enhance={() =>
								async ({ update, result }) => {
									await update();
									if (result.type === 'success') editingId = null;
								}}
							class="p-4 space-y-3 border-t border-border"
						>
							<input type="hidden" name="id" value={wh.id} />
							<div class="grid sm:grid-cols-2 gap-3">
								<label class="block">
									<span class="text-xs font-medium">{m.cms_webhooks_label()}</span>
									<input
										name="label"
										value={wh.label}
										required
										class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
									/>
								</label>
								<label class="block">
									<span class="text-xs font-medium">{m.cms_webhooks_url()}</span>
									<input
										name="url"
										type="url"
										value={wh.url}
										required
										class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
									/>
								</label>
							</div>
							<fieldset>
								<legend class="text-xs font-medium mb-1">{m.cms_webhooks_events()}</legend>
								<div class="flex flex-wrap gap-2">
									{#each data.knownEvents as event (event)}
										<label class="inline-flex items-center gap-1.5 px-2 py-1 border border-input rounded-md text-xs">
											<input
												type="checkbox"
												name="events"
												value={event}
												checked={wh.events.includes(event)}
												class="h-3.5 w-3.5"
											/>
											<code>{event}</code>
										</label>
									{/each}
								</div>
							</fieldset>
							<label class="inline-flex items-center gap-2 text-xs">
								<input
									type="checkbox"
									name="enabled"
									checked={wh.enabled}
									class="h-4 w-4"
								/>
								{m.cms_webhooks_enabled_label()}
							</label>
							<div class="flex gap-2">
								<button
									type="submit"
									class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm"
								>
									{m.cms_save()}
								</button>
							</div>
						</form>
						<form
							method="POST"
							action="?/rotate"
							use:enhance={({ cancel }) => {
								if (!confirm(m.cms_webhooks_rotate_confirm())) {
									cancel();
									return;
								}
								return async ({ update }) => update();
							}}
							class="px-4 pb-4"
						>
							<input type="hidden" name="id" value={wh.id} />
							<button
								type="submit"
								class="px-2.5 py-1 border border-border rounded-md text-xs hover:bg-muted"
							>
								{m.cms_webhooks_rotate()}
							</button>
						</form>
						<details class="px-4 pb-4 text-xs text-muted-foreground">
							<summary class="cursor-pointer">{m.cms_webhooks_show_secret()}</summary>
							<code class="mt-2 block break-all px-3 py-2 bg-muted rounded">
								{wh.secret}
							</code>
						</details>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
