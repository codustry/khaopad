<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui';
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

	function variantFor(status: CommentStatus) {
		if (status === 'pending') return 'default' as const;
		if (status === 'spam') return 'destructive' as const;
		return 'secondary' as const;
	}
</script>

<svelte:head>
	<title>{m.cms_comments()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_comments()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_comments_help()}</p>
		</div>
		{#if data.pendingCount > 0}
			<Badge variant="default">
				{m.cms_comments_pending_count({ count: String(data.pendingCount) })}
			</Badge>
		{/if}
	</header>

	{#if form?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
			{form.error}
		</div>
	{/if}

	<!-- Status tabs -->
	<div class="flex gap-2 border-b border-border">
		{#each tabs as t (t.key)}
			<a
				href={`?status=${t.key}`}
				class="px-4 py-2 text-sm border-b-2 -mb-px {data.status === t.key
					? 'border-primary text-foreground font-medium'
					: 'border-transparent text-muted-foreground hover:text-foreground'}"
			>
				{t.label}
			</a>
		{/each}
	</div>

	{#if data.items.length === 0}
		<div class="border border-dashed border-border rounded-lg p-8 text-center">
			<p class="text-sm text-muted-foreground">{m.cms_comments_empty()}</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each data.items as c (c.id)}
				{@const article = data.articleById[c.articleId]}
				<div class="border border-border rounded-md overflow-hidden">
					<div class="flex items-center gap-3 px-4 py-2.5 bg-muted/20">
						<Badge variant={variantFor(c.status)}>{c.status}</Badge>
						<span class="text-xs text-muted-foreground tabular-nums">
							{fmt(c.submittedAt)}
						</span>
						<span class="text-sm flex-1 min-w-0 truncate">
							<span class="font-medium">{c.authorName}</span>
							<span class="text-muted-foreground"> · {maskEmail(c.authorEmail)}</span>
						</span>
						{#if article}
							<a
								href={`/cms/articles/${c.articleId}`}
								class="text-xs text-muted-foreground hover:text-foreground truncate max-w-[180px]"
								title={article.title}
							>
								→ {article.title}
							</a>
						{/if}
					</div>
					<div class="p-4 space-y-3">
						<p class="text-sm whitespace-pre-wrap">{c.body}</p>
						<div class="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
							{#each ['approved', 'spam', 'archived'] as next (next)}
								{#if c.status !== next}
									<form method="POST" action="?/setStatus" use:enhance>
										<input type="hidden" name="id" value={c.id} />
										<input type="hidden" name="status" value={next} />
										<button
											type="submit"
											class="px-2.5 py-1 border border-border rounded-md text-xs hover:bg-muted capitalize"
										>
											Mark {next}
										</button>
									</form>
								{/if}
							{/each}
							<a
								href={`mailto:${c.authorEmail}?subject=Re: your comment`}
								class="px-2.5 py-1 border border-border rounded-md text-xs hover:bg-muted ml-auto"
							>
								{m.cms_comments_reply_email()}
							</a>
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
								<button
									type="submit"
									class="px-2.5 py-1 border border-destructive text-destructive rounded-md text-xs hover:bg-destructive/10"
								>
									{m.cms_delete()}
								</button>
							</form>
						</div>
					</div>
				</div>
			{/each}
		</div>

		{#if data.hasPrev || data.hasNext}
			<div class="flex items-center justify-between pt-2">
				{#if data.hasPrev}
					<a
						href={`?status=${data.status}&page=${data.page - 1}`}
						class="px-3 py-1.5 border border-border rounded-md text-sm hover:bg-muted"
					>
						← {m.cms_audit_prev()}
					</a>
				{:else}
					<span></span>
				{/if}
				{#if data.hasNext}
					<a
						href={`?status=${data.status}&page=${data.page + 1}`}
						class="px-3 py-1.5 border border-border rounded-md text-sm hover:bg-muted"
					>
						{m.cms_audit_next()} →
					</a>
				{/if}
			</div>
		{/if}
	{/if}
</div>
