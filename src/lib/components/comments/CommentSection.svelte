<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { HONEYPOT_FIELD } from '$lib/forms/constants';

	type Comment = { id: string; authorName: string; body: string; submittedAt: string };

	type Props = {
		articleId: string;
		comments: Comment[];
		open: boolean;
	};

	let { articleId, comments, open }: Props = $props();

	let submitting = $state(false);
	let success = $state(false);
	let errorMsg = $state<string | null>(null);

	let name = $state('');
	let email = $state('');
	let body = $state('');

	function fmt(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		});
	}

	async function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		errorMsg = null;
		success = false;
		submitting = true;
		try {
			const formEl = event.currentTarget as HTMLFormElement;
			const fd = new FormData(formEl);
			const res = await fetch('/api/comments', { method: 'POST', body: fd });
			if (!res.ok) {
				const text = await res.text();
				throw new Error(text || `Submission failed (${res.status})`);
			}
			success = true;
			name = '';
			email = '';
			body = '';
			// Refresh server data — newly-pending comment doesn't appear
			// publicly but the form resets via the success state.
			await invalidateAll();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}
</script>

<section class="mt-16 border-t border-border pt-10">
	<h2 class="text-xl font-bold mb-6">
		{m.comments_section_title({ count: String(comments.length) })}
	</h2>

	{#if comments.length === 0}
		<p class="text-sm text-muted-foreground mb-8">
			{m.comments_empty()}
		</p>
	{:else}
		<ol class="space-y-6 mb-10">
			{#each comments as c (c.id)}
				<li class="border-l-2 border-border pl-4">
					<div class="text-sm font-medium">{c.authorName}</div>
					<time class="text-xs text-muted-foreground">{fmt(c.submittedAt)}</time>
					<p class="mt-2 text-sm whitespace-pre-wrap leading-relaxed">{c.body}</p>
				</li>
			{/each}
		</ol>
	{/if}

	{#if open}
		<form onsubmit={onSubmit} class="space-y-4 max-w-xl">
			<h3 class="text-base font-semibold">{m.comments_form_title()}</h3>
			<input type="hidden" name="article_id" value={articleId} />
			<!-- Honeypot. Real visitors leave this empty; bots fill it. -->
			<input
				type="text"
				name={HONEYPOT_FIELD}
				tabindex="-1"
				autocomplete="off"
				class="absolute left-[-9999px] h-0 w-0 opacity-0"
				aria-hidden="true"
			/>
			<div class="grid sm:grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs font-medium">{m.comments_field_name()}</span>
					<input
						name="name"
						bind:value={name}
						required
						maxlength="80"
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
				</label>
				<label class="block">
					<span class="text-xs font-medium">{m.comments_field_email()}</span>
					<input
						name="email"
						type="email"
						bind:value={email}
						required
						maxlength="254"
						class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					/>
					<span class="text-xs text-muted-foreground">{m.comments_email_help()}</span>
				</label>
			</div>
			<label class="block">
				<span class="text-xs font-medium">{m.comments_field_body()}</span>
				<textarea
					name="body"
					bind:value={body}
					rows="4"
					required
					maxlength="4000"
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				></textarea>
			</label>

			{#if errorMsg}
				<div class="text-sm text-destructive">{errorMsg}</div>
			{/if}
			{#if success}
				<div class="text-sm text-emerald-700 dark:text-emerald-400">
					{m.comments_thanks()}
				</div>
			{/if}

			<button
				type="submit"
				disabled={submitting}
				class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
			>
				{submitting ? m.cms_saving() : m.comments_submit()}
			</button>
		</form>
	{:else}
		<p class="text-sm text-muted-foreground">{m.comments_closed()}</p>
	{/if}
</section>
