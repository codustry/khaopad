<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui';
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

	function statusOf(s: SubscriberRecord) {
		if (s.unsubscribedAt) return { label: 'unsubscribed', variant: 'secondary' as const };
		if (!s.confirmedAt) return { label: 'pending', variant: 'outline' as const };
		return { label: 'active', variant: 'default' as const };
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
</script>

<svelte:head>
	<title>{m.cms_subscribers()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_subscribers()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_subscribers_help()}</p>
		</div>
		<div class="flex items-center gap-3">
			<Badge variant="secondary">{data.totalActive} {m.cms_subscribers_active()}</Badge>
		</div>
	</header>

	{#if !data.providerConfigured}
		<div class="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
			<p class="font-medium">{m.cms_subscribers_no_provider_title()}</p>
			<p class="mt-1">{m.cms_subscribers_no_provider_help()}</p>
			<p class="mt-2">
				<a href="/cms/settings" class="underline hover:no-underline">/cms/settings →</a>
			</p>
		</div>
	{:else}
		<div class="rounded-md border border-border bg-card px-4 py-3 flex flex-wrap items-center justify-between gap-3">
			<div>
				<p class="text-sm font-medium">{m.cms_subscribers_send_digest()}</p>
				<p class="text-xs text-muted-foreground">{m.cms_subscribers_send_digest_help()}</p>
			</div>
			<div class="flex gap-2">
				<button
					type="button"
					disabled={sending}
					onclick={() => sendDigest(true)}
					class="px-3 py-1.5 border border-border rounded-md text-sm hover:bg-muted disabled:opacity-50"
				>
					{m.cms_subscribers_dry_run()}
				</button>
				<button
					type="button"
					disabled={sending}
					onclick={() => sendDigest(false)}
					class="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
				>
					{sending ? m.cms_saving() : m.cms_subscribers_send_now()}
				</button>
			</div>
		</div>
		{#if sendResult}
			<div class="rounded-md border border-border bg-muted/30 px-4 py-2.5 text-sm">
				{sendResult}
			</div>
		{/if}
	{/if}

	{#if data.subscribers.length === 0}
		<div class="border border-dashed border-border rounded-lg p-8 text-center">
			<p class="text-sm text-muted-foreground">{m.cms_subscribers_empty()}</p>
		</div>
	{:else}
		<div class="border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
					<tr>
						<th class="text-left px-4 py-2">{m.cms_subscribers_email()}</th>
						<th class="text-left px-4 py-2">{m.col_status()}</th>
						<th class="text-left px-4 py-2">Locale</th>
						<th class="text-left px-4 py-2">{m.cms_subscribers_signed_up()}</th>
						<th class="px-4 py-2"></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border">
					{#each data.subscribers as s (s.id)}
						{@const status = statusOf(s)}
						<tr class="hover:bg-muted/20">
							<td class="px-4 py-3 font-mono text-xs">{s.email}</td>
							<td class="px-4 py-3">
								<Badge variant={status.variant}>{status.label}</Badge>
							</td>
							<td class="px-4 py-3 text-xs text-muted-foreground uppercase">{s.locale}</td>
							<td class="px-4 py-3 text-xs text-muted-foreground tabular-nums">
								{fmt(s.createdAt)}
							</td>
							<td class="px-4 py-3 text-right">
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
									<input type="hidden" name="id" value={s.id} />
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
