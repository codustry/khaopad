<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, Input } from '$lib/components/ui';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let message = $state('');
	let submitting = $state(false);
</script>

<div class="max-w-2xl space-y-6 p-6">
	<header>
		<h1 class="text-2xl font-semibold">Hello plugin</h1>
		<p class="text-sm text-muted-foreground">
			Reference plugin for the v3.0 plugin runtime. Sends a ping, logs an audit
			action, fires the <code>hello.pinged</code> webhook event.
		</p>
	</header>

	<form
		method="POST"
		action="?/ping"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
				if (form?.success) message = '';
			};
		}}
		class="flex gap-2"
	>
		<Input
			name="message"
			bind:value={message}
			placeholder="Say something..."
			maxlength={500}
			required
			disabled={submitting}
		/>
		<Button type="submit" disabled={submitting || !message.trim()}>Ping</Button>
	</form>

	{#if form?.error}
		<p class="text-sm text-destructive">{form.error}</p>
	{/if}
	{#if form?.success}
		<p class="text-sm text-green-600">Sent ✓</p>
	{/if}

	<section>
		<h2 class="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Recent pings
		</h2>
		{#if data.pings.length === 0}
			<p class="text-sm text-muted-foreground">No pings yet. Send one above.</p>
		{:else}
			<ul class="space-y-2">
				{#each data.pings as ping (ping.id)}
					<li class="rounded-md border border-border p-3 text-sm">
						<div class="mb-1 text-xs text-muted-foreground">
							{new Date(ping.createdAt).toLocaleString()}
						</div>
						<div>{ping.message}</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
