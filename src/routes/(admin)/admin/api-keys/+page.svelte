<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import { KeyRound } from 'lucide-svelte';
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
		if (k.revokedAt) return { label: m.cms_api_keys_revoked(), status: 'cancelled' };
		if (k.expiresAt && k.expiresAt < new Date().toISOString())
			return { label: m.cms_api_keys_expired(), status: 'expired' };
		return { label: m.cms_api_keys_active(), status: 'active' };
	}

	const columns: Column<ApiKeyRecord>[] = [
		{ key: 'label', header: m.cms_api_keys_col_label(), cell: labelCell },
		{ key: 'prefix', header: m.cms_api_keys_col_prefix(), cell: prefixCell },
		{ key: 'scopes', header: m.cms_api_keys_col_scopes(), cell: scopesCell },
		{ key: 'lastUsed', header: m.cms_api_keys_col_last_used(), cell: lastUsedCell },
		{ key: 'status', header: m.col_status(), cell: statusCell },
		{ key: 'actions', header: '', align: 'right', cell: actionsCell }
	];
</script>

{#snippet labelCell(k: ApiKeyRecord)}
	<span class="font-medium">{k.label}</span>
{/snippet}

{#snippet prefixCell(k: ApiKeyRecord)}
	<span class="font-mono text-xs text-muted-foreground">{k.prefix}…</span>
{/snippet}

{#snippet scopesCell(k: ApiKeyRecord)}
	<span class="text-xs text-muted-foreground">{k.scopes.join(', ')}</span>
{/snippet}

{#snippet lastUsedCell(k: ApiKeyRecord)}
	<span class="text-xs text-muted-foreground">{fmt(k.lastUsedAt)}</span>
{/snippet}

{#snippet statusCell(k: ApiKeyRecord)}
	{@const s = statusBadge(k)}
	<StatusBadge status={s.status} label={s.label} />
{/snippet}

{#snippet actionsCell(k: ApiKeyRecord)}
	<div class="flex items-center justify-end gap-2">
		{#if !k.revokedAt}
			<form
				method="POST"
				action="?/revoke"
				use:enhance={({ cancel }) => {
					if (!confirm(m.cms_api_keys_revoke_confirm())) {
						cancel();
						return;
					}
					return async ({ update }) => update();
				}}
				class="inline"
			>
				<input type="hidden" name="id" value={k.id} />
				<Button type="submit" variant="outline" size="sm">{m.cms_api_keys_revoke()}</Button>
			</form>
		{/if}
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
			class="inline"
		>
			<input type="hidden" name="id" value={k.id} />
			<Button type="submit" variant="destructive" size="sm">{m.cms_delete()}</Button>
		</form>
	</div>
{/snippet}

<svelte:head>
	<title>{m.cms_api_keys()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader title={m.cms_api_keys()} description={m.cms_api_keys_help()} icon={KeyRound}>
		{#snippet actions()}
			<Button type="button" onclick={() => (createOpen = !createOpen)}>
				{createOpen ? m.cms_cancel() : m.cms_api_keys_new()}
			</Button>
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				{form.error}
			</div>
		{/if}

		{#if form?.ok && form.created}
			<!-- One-time secret display. The raw key is never reachable again. -->
			<div
				class="space-y-3 rounded-md border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30"
			>
				<div>
					<p class="font-semibold text-amber-900 dark:text-amber-100">
						{m.cms_api_keys_created_title({ label: form.created.label })}
					</p>
					<p class="mt-1 text-xs text-amber-800 dark:text-amber-200">
						{m.cms_api_keys_created_warning()}
					</p>
				</div>
				<code
					class="block break-all rounded border border-amber-300 bg-background px-3 py-2 font-mono text-xs dark:border-amber-700"
				>
					{form.created.rawKey}
				</code>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onclick={() => navigator.clipboard.writeText(form?.created?.rawKey ?? '')}
				>
					{m.cms_api_keys_copy()}
				</Button>
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
				class="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
			>
				<h2 class="font-semibold">{m.cms_api_keys_new()}</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block">
						<span class="text-xs font-medium">{m.cms_api_keys_label()}</span>
						<input
							name="label"
							required
							placeholder="e.g. mobile-app-prod"
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</label>
					<label class="block">
						<span class="text-xs font-medium">{m.cms_api_keys_expires_at()}</span>
						<input
							name="expires_at"
							type="datetime-local"
							class="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
						<span class="text-xs text-muted-foreground">{m.cms_api_keys_expires_at_help()}</span>
					</label>
				</div>
				<fieldset>
					<legend class="mb-1 text-xs font-medium">{m.cms_api_keys_scopes()}</legend>
					<div class="flex flex-wrap gap-2">
						{#each data.knownScopes as scope (scope)}
							<label
								class="inline-flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs"
							>
								<input type="checkbox" name="scopes" value={scope} class="h-3.5 w-3.5" />
								<code>{scope}</code>
							</label>
						{/each}
					</div>
				</fieldset>
				<Button type="submit">{m.cms_api_keys_create()}</Button>
			</form>
		{/if}

		<DataTable columns={columns} rows={data.keys} getKey={(k) => k.id}>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">{m.cms_api_keys_empty()}</p>
			{/snippet}
		</DataTable>
	</div>
</PageShell>
