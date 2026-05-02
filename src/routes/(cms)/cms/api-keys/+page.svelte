<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui';
	import type { ApiKeyRecord, ApiKeyScope } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: { keys: ApiKeyRecord[]; knownScopes: ApiKeyScope[] };
		form:
			| {
					ok?: boolean;
					error?: string;
					created?: { id: string; label: string; rawKey: string };
			  }
			| null;
	} = $props();

	let createOpen = $state(false);

	function fmt(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	function statusBadge(k: ApiKeyRecord) {
		if (k.revokedAt) return { label: m.cms_api_keys_revoked(), variant: 'destructive' as const };
		if (k.expiresAt && k.expiresAt < new Date().toISOString())
			return { label: m.cms_api_keys_expired(), variant: 'secondary' as const };
		return { label: m.cms_api_keys_active(), variant: 'default' as const };
	}
</script>

<svelte:head>
	<title>{m.cms_api_keys()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_api_keys()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_api_keys_help()}</p>
		</div>
		<button
			type="button"
			onclick={() => (createOpen = !createOpen)}
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
		>
			{createOpen ? m.cms_cancel() : m.cms_api_keys_new()}
		</button>
	</header>

	{#if form?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
			{form.error}
		</div>
	{/if}

	{#if form?.ok && form.created}
		<!-- One-time secret display. The raw key is never reachable again. -->
		<div class="rounded-md border-2 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 p-4 space-y-3">
			<div>
				<p class="font-semibold text-amber-900 dark:text-amber-100">
					{m.cms_api_keys_created_title({ label: form.created.label })}
				</p>
				<p class="text-xs text-amber-800 dark:text-amber-200 mt-1">
					{m.cms_api_keys_created_warning()}
				</p>
			</div>
			<code class="block break-all px-3 py-2 bg-white dark:bg-black/30 border border-amber-300 dark:border-amber-700 rounded font-mono text-xs">
				{form.created.rawKey}
			</code>
			<button
				type="button"
				onclick={() => navigator.clipboard.writeText(form?.created?.rawKey ?? '')}
				class="px-3 py-1.5 border border-amber-300 dark:border-amber-700 rounded-md text-xs hover:bg-amber-100 dark:hover:bg-amber-900"
			>
				{m.cms_api_keys_copy()}
			</button>
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
			class="space-y-3 border border-border rounded-lg p-4 bg-muted/20"
		>
			<h2 class="font-semibold">{m.cms_api_keys_new()}</h2>
			<div class="grid sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs font-medium">{m.cms_api_keys_label()}</span>
					<input
						name="label"
						required
						placeholder="e.g. mobile-app-prod"
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.cms_api_keys_expires_at()}</span>
					<input
						name="expires_at"
						type="datetime-local"
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
					<span class="text-xs text-muted-foreground">{m.cms_api_keys_expires_at_help()}</span>
				</label>
			</div>
			<fieldset>
				<legend class="text-xs font-medium mb-1">{m.cms_api_keys_scopes()}</legend>
				<div class="flex flex-wrap gap-2">
					{#each data.knownScopes as scope (scope)}
						<label class="inline-flex items-center gap-1.5 px-2 py-1 border border-input rounded-md text-xs">
							<input type="checkbox" name="scopes" value={scope} class="h-3.5 w-3.5" />
							<code>{scope}</code>
						</label>
					{/each}
				</div>
			</fieldset>
			<button type="submit" class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
				{m.cms_api_keys_create()}
			</button>
		</form>
	{/if}

	{#if data.keys.length === 0}
		<div class="border border-dashed border-border rounded-lg p-8 text-center">
			<p class="text-sm text-muted-foreground">{m.cms_api_keys_empty()}</p>
		</div>
	{:else}
		<div class="border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
					<tr>
						<th class="text-left px-4 py-2">{m.cms_api_keys_col_label()}</th>
						<th class="text-left px-4 py-2">{m.cms_api_keys_col_prefix()}</th>
						<th class="text-left px-4 py-2">{m.cms_api_keys_col_scopes()}</th>
						<th class="text-left px-4 py-2">{m.cms_api_keys_col_last_used()}</th>
						<th class="text-left px-4 py-2">{m.col_status()}</th>
						<th class="text-right px-4 py-2"></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each data.keys as k (k.id)}
						{@const status = statusBadge(k)}
						<tr class="hover:bg-muted/20">
							<td class="px-4 py-3 font-medium">{k.label}</td>
							<td class="px-4 py-3 font-mono text-xs text-muted-foreground">
								{k.prefix}…
							</td>
							<td class="px-4 py-3 text-xs text-muted-foreground">
								{k.scopes.join(', ')}
							</td>
							<td class="px-4 py-3 text-xs text-muted-foreground">{fmt(k.lastUsedAt)}</td>
							<td class="px-4 py-3">
								<Badge variant={status.variant}>{status.label}</Badge>
							</td>
							<td class="px-4 py-3 text-right">
								{#if !k.revokedAt}
									<form method="POST" action="?/revoke" use:enhance={({ cancel }) => {
										if (!confirm(m.cms_api_keys_revoke_confirm())) {
											cancel();
											return;
										}
										return async ({ update }) => update();
									}} class="inline">
										<input type="hidden" name="id" value={k.id} />
										<button
											type="submit"
											class="px-2.5 py-1 border border-border rounded-md text-xs hover:bg-muted"
										>
											{m.cms_api_keys_revoke()}
										</button>
									</form>
								{/if}
								<form method="POST" action="?/delete" use:enhance={({ cancel }) => {
									if (!confirm(m.cms_delete_confirm())) {
										cancel();
										return;
									}
									return async ({ update }) => update();
								}} class="inline">
									<input type="hidden" name="id" value={k.id} />
									<button
										type="submit"
										class="px-2.5 py-1 border border-destructive text-destructive rounded-md text-xs hover:bg-destructive/10"
									>
										{m.cms_delete()}
									</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
