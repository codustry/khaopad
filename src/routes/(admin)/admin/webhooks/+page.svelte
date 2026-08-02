<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader, StatusBadge } from '$lib/components/admin';
	import { Webhook } from 'lucide-svelte';
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

<PageShell>
	<PageHeader title={m.cms_webhooks()} description={m.cms_webhooks_help()} icon={Webhook}>
		{#snippet actions()}
			<Button type="button" onclick={startCreate}>{m.cms_webhooks_new()}</Button>
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				{form.error}
			</div>
		{/if}

		{#if form?.ok && form.webhookId}
			<div
				class="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30"
			>
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
				class="space-y-4 rounded-lg border border-border bg-muted/20 p-4"
			>
				<h2 class="font-semibold">{m.cms_webhooks_new()}</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block">
						<span class="text-xs font-medium">{m.cms_webhooks_label()}</span>
						<input
							name="label"
							required
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</label>
					<label class="block">
						<span class="text-xs font-medium">{m.cms_webhooks_url()}</span>
						<input
							name="url"
							type="url"
							required
							placeholder="https://example.com/hook"
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
						/>
					</label>
				</div>
				<fieldset class="block">
					<legend class="mb-1 text-xs font-medium">{m.cms_webhooks_events()}</legend>
					<div class="flex flex-wrap gap-2">
						{#each data.knownEvents as event (event)}
							<label
								class="inline-flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs"
							>
								<input type="checkbox" name="events" value={event} class="h-3.5 w-3.5" />
								<code>{event}</code>
							</label>
						{/each}
					</div>
				</fieldset>
				<Button type="submit">{m.cms_webhooks_create()}</Button>
			</form>
		{/if}

		{#if data.webhooks.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center">
				<p class="text-sm text-muted-foreground">{m.cms_webhooks_empty()}</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each data.webhooks as wh (wh.id)}
					<div class="rounded-md border border-border">
						<div class="flex items-center gap-3 rounded-t-md bg-muted/20 px-4 py-3">
							<StatusBadge
								status={wh.enabled ? 'active' : 'archived'}
								label={wh.enabled ? m.cms_webhooks_enabled() : m.cms_webhooks_disabled()}
							/>
							<div class="min-w-0 flex-1">
								<div class="truncate text-sm font-medium">{wh.label}</div>
								<code class="block truncate font-mono text-xs text-muted-foreground">
									{wh.url}
								</code>
							</div>
							<div class="flex items-center gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onclick={() => (editingId === wh.id ? (editingId = null) : startEdit(wh.id))}
								>
									{editingId === wh.id ? m.cms_cancel() : m.cms_edit_article()}
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
									<input type="hidden" name="id" value={wh.id} />
									<Button type="submit" variant="destructive" size="sm">
										{m.cms_delete()}
									</Button>
								</form>
							</div>
						</div>
						<div
							class="flex flex-wrap items-center gap-2 bg-background px-4 py-2.5 text-xs text-muted-foreground"
						>
							<span>{m.cms_webhooks_subscribed()}:</span>
							{#each wh.events as event (event)}
								<code class="rounded bg-muted px-1.5 py-0.5">{event}</code>
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
								class="space-y-3 border-t border-border p-4"
							>
								<input type="hidden" name="id" value={wh.id} />
								<div class="grid gap-3 sm:grid-cols-2">
									<label class="block">
										<span class="text-xs font-medium">{m.cms_webhooks_label()}</span>
										<input
											name="label"
											value={wh.label}
											required
											class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
										/>
									</label>
									<label class="block">
										<span class="text-xs font-medium">{m.cms_webhooks_url()}</span>
										<input
											name="url"
											type="url"
											value={wh.url}
											required
											class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
										/>
									</label>
								</div>
								<fieldset>
									<legend class="mb-1 text-xs font-medium">{m.cms_webhooks_events()}</legend>
									<div class="flex flex-wrap gap-2">
										{#each data.knownEvents as event (event)}
											<label
												class="inline-flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs"
											>
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
									<input type="checkbox" name="enabled" checked={wh.enabled} class="h-4 w-4" />
									{m.cms_webhooks_enabled_label()}
								</label>
								<div class="flex gap-2">
									<Button type="submit">{m.cms_save()}</Button>
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
								<Button type="submit" variant="outline" size="sm">
									{m.cms_webhooks_rotate()}
								</Button>
							</form>
							<details class="px-4 pb-4 text-xs text-muted-foreground">
								<summary class="cursor-pointer">{m.cms_webhooks_show_secret()}</summary>
								<code class="mt-2 block break-all rounded bg-muted px-3 py-2">
									{wh.secret}
								</code>
							</details>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</PageShell>
