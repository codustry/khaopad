<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { Button, Input, Label } from '$lib/components/ui';
	import { ArrowLeft, MailCheck } from 'lucide-svelte';

	type ActionResult = { sent?: boolean; invalid?: boolean } | null;

	let { form }: { form: ActionResult } = $props();

	let email = $state('');
	let submitting = $state(false);
</script>

<svelte:head>
	<title>{m.cms_forgot_password_title()} — {m.cms_app_name()}</title>
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

		{#if form?.sent}
			<!--
				The confirmation deliberately says "if that email matches an
				account" rather than "sent": the server cannot tell the user
				whether it matched without leaking account existence, so the
				copy has to be honest about the ambiguity.
			-->
			<div class="space-y-4">
				<div
					class="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-3"
				>
					<MailCheck class="mt-0.5 h-5 w-5 shrink-0 text-primary" />
					<div class="space-y-1">
						<p class="text-sm">{m.cms_forgot_password_sent()}</p>
						<p class="text-xs text-muted-foreground">
							{m.cms_forgot_password_limit_note()}
						</p>
					</div>
				</div>
				<a
					href={resolve('/(admin)/admin/login')}
					class="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					<ArrowLeft class="h-4 w-4" />
					{m.cms_forgot_password_back()}
				</a>
			</div>
		{:else}
			<div class="mb-6">
				<h1 class="text-2xl font-semibold tracking-tight">
					{m.cms_forgot_password_title()}
				</h1>
				<p class="mt-1.5 text-sm text-muted-foreground">
					{m.cms_forgot_password_description()}
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
				{#if form?.invalid}
					<div
						class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
					>
						{m.cms_forgot_password_invalid_email()}
					</div>
				{/if}

				<div class="space-y-1.5">
					<Label for="email">{m.cms_email()}</Label>
					<Input
						id="email"
						name="email"
						type="email"
						bind:value={email}
						required
						autocomplete="email"
						placeholder="admin@example.com"
					/>
				</div>

				<Button type="submit" disabled={submitting} class="w-full">
					{submitting ? m.cms_forgot_password_sending() : m.cms_forgot_password_submit()}
				</Button>

				<p class="text-xs text-muted-foreground">
					{m.cms_forgot_password_limit_note()}
				</p>

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
