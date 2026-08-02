<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { Badge, Button } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, StatusBadge, type Column } from '$lib/components/admin';
	import { Mail } from 'lucide-svelte';
	import type { SubscriberRecord } from '$lib/server/content/types';

	let {
		data,
	}: {
		data: {
			subscribers: SubscriberRecord[];
			totalActive: number;
			providerConfigured: boolean;
		};
	} = $props();

	let sending = $state(false);
	let sendResult = $state<string | null>(null);

	function fmt(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	function statusOf(s: SubscriberRecord): string {
		if (s.unsubscribedAt) return 'unsubscribed';
		if (!s.confirmedAt) return 'pending';
		return 'active';
	}

	type DigestResponse = {
		ok: boolean;
		dryRun?: boolean;
		subscribers?: number;
		articleCounts?: Record<string, number>;
		sent?: number;
		failed?: number;
		message?: string;
	};

	async function sendDigest(dryRun: boolean) {
		sending = true;
		sendResult = null;
		try {
			const res = await fetch(
				`/api/newsletter/send-digest?days=7${dryRun ? '&dryRun=1' : ''}`,
				{ method: 'POST' },
			);
			const body = (await res.json().catch(() => null)) as DigestResponse | null;
			if (!res.ok) {
				sendResult = `Failed: ${body?.message ?? res.status}`;
			} else if (dryRun) {
				sendResult = `Dry run: would send to ${body?.subscribers ?? 0} subscribers (article counts: ${JSON.stringify(body?.articleCounts ?? {})})`;
			} else {
				sendResult = `Sent ${body?.sent ?? 0}, failed ${body?.failed ?? 0}.`;
				await invalidateAll();
			}
		} catch (err) {
			sendResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			sending = false;
		}
	}

	const columns: Column<SubscriberRecord>[] = [
		{ key: 'email', header: m.cms_subscribers_email(), cell: emailCell },
		{ key: 'status', header: m.col_status(), cell: statusCell },
		{ key: 'locale', header: 'Locale', cell: localeCell },
		{ key: 'signedUp', header: m.cms_subscribers_signed_up(), cell: signedUpCell },
		{ key: 'actions', header: '', align: 'right', cell: actionsCell }
	];
</script>

{#snippet emailCell(s: SubscriberRecord)}
	<span class="font-mono text-xs">{s.email}</span>
{/snippet}

{#snippet statusCell(s: SubscriberRecord)}
	<StatusBadge status={statusOf(s)} />
{/snippet}

{#snippet localeCell(s: SubscriberRecord)}
	<span class="text-xs uppercase text-muted-foreground">{s.locale}</span>
{/snippet}

{#snippet signedUpCell(s: SubscriberRecord)}
	<span class="text-xs tabular-nums text-muted-foreground">{fmt(s.createdAt)}</span>
{/snippet}

{#snippet actionsCell(s: SubscriberRecord)}
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
		<input type="hidden" name="id" value={s.id} />
		<Button type="submit" variant="destructive" size="sm">{m.cms_delete()}</Button>
	</form>
{/snippet}

<svelte:head>
	<title>{m.cms_subscribers()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader title={m.cms_subscribers()} description={m.cms_subscribers_help()} icon={Mail}>
		{#snippet actions()}
			<Badge variant="secondary">{data.totalActive} {m.cms_subscribers_active()}</Badge>
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if !data.providerConfigured}
			<div
				class="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
			>
				<p class="font-medium">{m.cms_subscribers_no_provider_title()}</p>
				<p class="mt-1">{m.cms_subscribers_no_provider_help()}</p>
				<p class="mt-2">
					<a href={resolve('/(admin)/admin/settings')} class="underline hover:no-underline"
						>/admin/settings →</a
					>
				</p>
			</div>
		{:else}
			<div
				class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3"
			>
				<div>
					<p class="text-sm font-medium">{m.cms_subscribers_send_digest()}</p>
					<p class="text-xs text-muted-foreground">{m.cms_subscribers_send_digest_help()}</p>
				</div>
				<div class="flex gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={sending}
						onclick={() => sendDigest(true)}
					>
						{m.cms_subscribers_dry_run()}
					</Button>
					<Button type="button" size="sm" disabled={sending} onclick={() => sendDigest(false)}>
						{sending ? m.cms_saving() : m.cms_subscribers_send_now()}
					</Button>
				</div>
			</div>
			{#if sendResult}
				<div class="rounded-md border border-border bg-muted/30 px-4 py-2.5 text-sm">
					{sendResult}
				</div>
			{/if}
		{/if}

		<DataTable columns={columns} rows={data.subscribers} getKey={(s) => s.id}>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">{m.cms_subscribers_empty()}</p>
			{/snippet}
		</DataTable>
	</div>
</PageShell>
