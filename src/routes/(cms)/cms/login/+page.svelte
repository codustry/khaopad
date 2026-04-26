<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { submitEmailLogin } from './login-submit';
	let { data }: { data: { bootstrapNeeded?: boolean } } = $props();

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let loading = $state(false);

	// @ts-expect-error Svelte parser rejects `e: SubmitEvent`; `e` is the form submit event
	async function handleLogin(e) {
		if (!(e instanceof SubmitEvent)) return;
		loading = true;
		error = '';

		try {
			const result = await submitEmailLogin(e, { email, password });
			if (!result.ok) {
				error = result.error;
				return;
			}
			window.location.href = '/cms/dashboard';
		} catch {
			error = 'Something went wrong';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>{m.cms_sign_in()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center">
	<div class="w-full max-w-sm">
		<div class="text-center mb-8">
			<h1 class="text-2xl font-bold">{m.cms_app_name()}</h1>
			<p class="text-muted-foreground text-sm mt-2">{m.cms_sign_in_description()}</p>
		</div>

		{#if data.bootstrapNeeded}
			<div class="mb-4 border border-border rounded-md bg-muted/50 p-3 text-sm">
				No admin exists yet. <a href="/cms/signup" class="underline font-medium">{m.cms_sign_up()}</a>
			</div>
		{/if}

		<form onsubmit={handleLogin} class="space-y-4">
			{#if error}
				<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
					{error}
				</div>
			{/if}

			<div>
				<label for="email" class="block text-sm font-medium mb-1">{m.cms_email()}</label>
				<input
					id="email"
					type="email"
					bind:value={email}
					required
					class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					placeholder="admin@example.com"
				/>
			</div>

			<div>
				<label for="password" class="block text-sm font-medium mb-1">{m.cms_password()}</label>
				<input
					id="password"
					type="password"
					bind:value={password}
					required
					class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				class="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
			>
				{loading ? m.cms_signing_in() : m.cms_sign_in()}
			</button>
		</form>
	</div>
</div>
