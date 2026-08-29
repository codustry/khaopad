<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { Button, Input, Label } from '$lib/components/ui';
	import { ArrowLeft, CheckCircle2 } from 'lucide-svelte';
	import type { PageData } from './$types';

	type ActionResult = {
		ok?: boolean;
		invalidToken?: boolean;
		tooShort?: boolean;
		mismatch?: boolean;
		rateLimited?: boolean;
		unavailable?: boolean;
	} | null;

	let { data, form }: { data: PageData; form: ActionResult } = $props();

	let newPassword = $state('');
	let confirmPassword = $state('');
	let submitting = $state(false);

	// Read from the URL rather than threaded through the form: the token
	// never needs to survive a failed submit round-trip, and keeping it out
	// of component state means it cannot leak into a Svelte devtools dump.
	const token = $derived(page.url.searchParams.get('token') ?? '');

	// Convenience only — the action re-checks both. Same split the profile
	// page uses: a client-side guard saves a round trip, it is not a control.
	const mismatch = $derived(
		confirmPassword.length > 0 && newPassword !== confirmPassword
	);
	const canSubmit = $derived(newPassword.length >= 8 && !mismatch);

	const linkBroken = $derived(
		!data.hasToken || data.linkError.length > 0 || form?.invalidToken === true
	);
</script>

<svelte:head>
	<title>{m.cms_reset_password_title()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="flex min-h-screen flex-col justify-center px-6 py-12 sm:px-12">
	<div class="mx-auto w-full max-w-sm">
		<div class="mb-8 flex items-center gap-2.5">
			<span
				class="grid h-9 w-9 place-items-center rounded-md bg-primary font-bold text-primary-foreground"
			>
				ข
			</span>
			<span class="text-base font-semibold tracking-tight">Khao Pad</span>
		</div>

		{#if form?.ok}
			<div class="space-y-4">
				<div
					class="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-3"
				>
					<CheckCircle2 class="mt-0.5 h-5 w-5 shrink-0 text-primary" />
					<p class="text-sm">{m.cms_reset_password_done()}</p>
				</div>
				<a
					href={resolve('/(admin)/admin/login')}
					class="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
				>
					{m.cms_sign_in()}
				</a>
			</div>
		{:else if linkBroken}
			<div class="space-y-4">
				<div
					class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
				>
					{data.hasToken
						? m.cms_reset_password_invalid()
						: m.cms_reset_password_missing_token()}
				</div>
				<a
					href={resolve('/(admin)/admin/forgot-password')}
					class="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
				>
					{m.cms_forgot_password_submit()}
				</a>
			</div>
		{:else}
			<div class="mb-6">
				<h1 class="text-2xl font-semibold tracking-tight">
					{m.cms_reset_password_title()}
				</h1>
				<p class="mt-1.5 text-sm text-muted-foreground">
					{m.cms_reset_password_description()}
				</p>
			</div>

			<form
				method="POST"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
					};
				}}
				class="space-y-4"
			>
				<input type="hidden" name="token" value={token} />

				{#if form?.rateLimited}
					<div
						class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
					>
						{m.cms_rate_limited()}
					</div>
				{:else if form?.tooShort}
					<div
						class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
					>
						{m.cms_password_new_help()}
					</div>
				{:else if form?.mismatch}
					<div
						class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
					>
						{m.cms_password_mismatch()}
					</div>
				{/if}

				<div class="space-y-1.5">
					<Label for="newPassword">{m.cms_password_new()}</Label>
					<Input
						id="newPassword"
						name="newPassword"
						type="password"
						bind:value={newPassword}
						required
						minlength={8}
						autocomplete="new-password"
					/>
					<p class="text-xs text-muted-foreground">{m.cms_password_new_help()}</p>
				</div>

				<div class="space-y-1.5">
					<Label for="confirmPassword">{m.cms_password_confirm()}</Label>
					<Input
						id="confirmPassword"
						name="confirmPassword"
						type="password"
						bind:value={confirmPassword}
						required
						autocomplete="new-password"
					/>
					{#if mismatch}
						<p class="text-xs text-destructive">{m.cms_password_mismatch()}</p>
					{/if}
				</div>

				<Button type="submit" disabled={submitting || !canSubmit} class="w-full">
					{submitting ? m.cms_reset_password_saving() : m.cms_reset_password_submit()}
				</Button>

				<a
					href={resolve('/(admin)/admin/login')}
					class="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					<ArrowLeft class="h-4 w-4" />
					{m.cms_forgot_password_back()}
				</a>
			</form>
		{/if}
	</div>
</div>
