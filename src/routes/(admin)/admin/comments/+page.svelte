<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Badge, Button } from '$lib/components/ui';
	import { PageShell, PageHeader, StatusBadge, type StatusTone } from '$lib/components/admin';
	import { MessageSquare } from 'lucide-svelte';
	import { maskEmail } from '$lib/comments/mask';
	import type { CommentRecord, CommentStatus } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: {
			items: CommentRecord[];
			articleById: Record<string, { slug: string; title: string }>;
			status: CommentStatus;
			page: number;
			hasPrev: boolean;
			hasNext: boolean;
			pendingCount: number;
		};
		form: { ok?: boolean; error?: string } | null;
	} = $props();

	const tabs: Array<{ key: CommentStatus; label: string }> = [
		{ key: 'pending', label: m.cms_comments_status_pending() },
		{ key: 'approved', label: m.cms_comments_status_approved() },
		{ key: 'spam', label: m.cms_comments_status_spam() },
		{ key: 'archived', label: m.cms_comments_status_archived() },
	];

	function fmt(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}

	// `approved` is not in StatusBadge's default map, and `spam` must read as
	// a hazard rather than a neutral state, so both are pinned here.
	function toneFor(status: CommentStatus): StatusTone {
		if (status === 'approved') return 'success';
		if (status === 'spam') return 'danger';
		if (status === 'pending') return 'warning';
		return 'neutral';
	}
</script>

<svelte:head>
	<title>{m.cms_comments()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell>
	<PageHeader title={m.cms_comments()} description={m.cms_comments_help()} icon={MessageSquare}>
		{#snippet actions()}
			{#if data.pendingCount > 0}
				<Badge variant="default">
					{m.cms_comments_pending_count({ count: String(data.pendingCount) })}
				</Badge>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				{form.error}
			</div>
		{/if}

		<!-- Status tabs -->
		<div class="flex gap-2 border-b border-border">
			{#each tabs as t (t.key)}
				<a
					href={resolve(`/(admin)/admin/comments?status=${t.key}`)}
					class="-mb-px border-b-2 px-4 py-2 text-sm {data.status === t.key
						? 'border-primary font-medium text-foreground'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
				>
					{t.label}
				</a>
			{/each}
		</div>

		{#if data.items.length === 0}
			<div class="rounded-lg border border-dashed border-border p-8 text-center">
				<p class="text-sm text-muted-foreground">{m.cms_comments_empty()}</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each data.items as c (c.id)}
					{@const article = data.articleById[c.articleId]}
					<div class="rounded-md border border-border">
						<div class="flex items-center gap-3 rounded-t-md bg-muted/20 px-4 py-2.5">
							<StatusBadge status={c.status} tone={toneFor(c.status)} />
							<span class="text-xs tabular-nums text-muted-foreground">
								{fmt(c.submittedAt)}
							</span>
							<span class="min-w-0 flex-1 truncate text-sm">
								<span class="font-medium">{c.authorName}</span>
								<span class="text-muted-foreground"> · {maskEmail(c.authorEmail)}</span>
							</span>
							{#if article}
								<a
									href={resolve('/(admin)/admin/articles/[id]', { id: c.articleId })}
									class="max-w-[180px] truncate text-xs text-muted-foreground hover:text-foreground"
									title={article.title}
								>
									→ {article.title}
								</a>
							{/if}
						</div>
						<div class="space-y-3 p-4">
							<p class="whitespace-pre-wrap text-sm">{c.body}</p>
							<div class="flex flex-wrap items-center gap-2 border-t border-border pt-2">
								{#each ['approved', 'spam', 'archived'] as next (next)}
									{#if c.status !== next}
										<form method="POST" action="?/setStatus" use:enhance>
											<input type="hidden" name="id" value={c.id} />
											<input type="hidden" name="status" value={next} />
											<Button type="submit" variant="outline" size="sm" class="capitalize">
												Mark {next}
											</Button>
										</form>
									{/if}
								{/each}
								<Button
									href={`mailto:${c.authorEmail}?subject=Re: your comment`}
									variant="outline"
									size="sm"
									class="ml-auto"
								>
									{m.cms_comments_reply_email()}
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
									<input type="hidden" name="id" value={c.id} />
									<Button type="submit" variant="destructive" size="sm">
										{m.cms_delete()}
									</Button>
								</form>
							</div>
						</div>
					</div>
				{/each}
			</div>

			{#if data.hasPrev || data.hasNext}
				<div class="flex items-center justify-between pt-2">
					{#if data.hasPrev}
						<Button
							href={resolve(`/(admin)/admin/comments?status=${data.status}&page=${data.page - 1}`)}
							variant="outline"
							size="sm"
						>
							← {m.cms_audit_prev()}
						</Button>
					{:else}
						<span></span>
					{/if}
					{#if data.hasNext}
						<Button
							href={resolve(`/(admin)/admin/comments?status=${data.status}&page=${data.page + 1}`)}
							variant="outline"
							size="sm"
						>
							{m.cms_audit_next()} →
						</Button>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</PageShell>
