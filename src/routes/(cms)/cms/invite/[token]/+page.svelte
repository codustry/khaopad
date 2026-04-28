<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Button, Card, CardContent, Input, Label } from '$lib/components/ui';
	import type { PageData } from './$types';

	let {
		data,
		form,
	}: {
		data: PageData;
		form: { ok?: boolean; error?: string } | null;
	} = $props();

	let name = $state('');
	let password = $state('');
	let loading = $state(false);
</script>

<svelte:head>
	<title>{m.cms_invite_accept_title()} — {m.cms_app_name()}</title>
</svelte:head>

<section class="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-md flex-col justify-center px-5 py-12">
	{#if data.state !== 'open'}
		<Card>
			<CardContent class="space-y-2 p-6">
				<h1 class="text-lg font-semibold tracking-tight">
					{m.cms_invite_accept_unavailable()}
				</h1>
				<p class="text-sm text-muted-foreground">{data.reason}</p>
				<a href="/cms/login" class="text-sm font-medium text-primary underline-offset-4 hover:underline">
					{m.cms_sign_in()}
				</a>
			</CardContent>
		</Card>
	{:else}
		<header class="mb-6">
			<h1 class="text-2xl font-semibold tracking-tight">{m.cms_invite_accept_title()}</h1>
			<p class="mt-1.5 text-sm text-muted-foreground">
				{m.cms_invite_accept_help({ email: data.email, role: data.role })}
			</p>
		</header>

		<form
			method="POST"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					await update();
					loading = false;
				};
			}}
		>
			{#if form?.error}
				<div
					class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
				>
					{form.error}
				</div>
			{/if}

			<Card>
				<CardContent class="space-y-4 p-6">
					<div class="space-y-1.5">
						<Label for="email">{m.cms_email()}</Label>
						<Input id="email" type="email" value={data.email} disabled />
					</div>
					<div class="space-y-1.5">
						<Label for="name">{m.cms_name()}</Label>
						<Input id="name" name="name" bind:value={name} required autocomplete="name" />
					</div>
					<div class="space-y-1.5">
						<Label for="password">{m.cms_password()}</Label>
						<Input
							id="password"
							name="password"
							type="password"
							bind:value={password}
							required
							minlength={8}
							autocomplete="new-password"
						/>
					</div>
				</CardContent>
			</Card>

			<Button type="submit" disabled={loading} class="mt-4 w-full">
				{loading ? m.cms_signing_up() : m.cms_invite_accept_submit()}
			</Button>
		</form>
	{/if}
</section>
