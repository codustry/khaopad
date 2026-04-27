<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';

	let { form }: { form: { ok?: boolean; error?: string } | null } = $props();
	let loading = $state(false);
</script>

<svelte:head>
	<title>{m.cms_sign_up()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center">
	<div class="w-full max-w-sm">
		<div class="text-center mb-8">
			<h1 class="text-2xl font-bold">{m.cms_app_name()}</h1>
			<p class="text-muted-foreground text-sm mt-2">{m.cms_sign_up_description()}</p>
		</div>

		<form
			method="POST"
			class="space-y-4"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					await update();
					loading = false;
				};
			}}
		>
			{#if form?.error}
				<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
					{form.error}
				</div>
			{/if}

			<div>
				<label for="name" class="block text-sm font-medium mb-1">{m.cms_name()}</label>
				<input
					id="name"
					name="name"
					required
					class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</div>

			<div>
				<label for="email" class="block text-sm font-medium mb-1">{m.cms_email()}</label>
				<input
					id="email"
					name="email"
					type="email"
					required
					class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
					placeholder="admin@example.com"
				/>
			</div>

			<div>
				<label for="password" class="block text-sm font-medium mb-1">{m.cms_password()}</label>
				<input
					id="password"
					name="password"
					type="password"
					required
					minlength={8}
					class="w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				class="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
			>
				{loading ? m.cms_signing_up() : m.cms_sign_up()}
			</button>
		</form>
	</div>
</div>
