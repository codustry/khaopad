<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Button, Input, Label } from '$lib/components/ui';
	import { ArrowRight, Crown } from 'lucide-svelte';

	let { form }: { form: { ok?: boolean; error?: string } | null } = $props();
	let loading = $state(false);
</script>

<svelte:head>
	<title>{m.cms_sign_up()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="grid min-h-screen lg:grid-cols-2">
	<!-- Left: brand panel -->
	<aside
		class="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-sidebar-background p-10 text-sidebar-foreground lg:flex"
	>
		<div
			aria-hidden="true"
			class="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-primary/5 blur-3xl"
		></div>
		<div
			aria-hidden="true"
			class="pointer-events-none absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-primary/10 blur-3xl"
		></div>

		<a href="/" class="relative flex items-center gap-2.5">
			<span
				class="grid h-9 w-9 place-items-center rounded-md bg-primary font-bold text-primary-foreground"
			>
				ข
			</span>
			<span class="text-base font-semibold tracking-tight">Khao Pad</span>
		</a>

		<div class="relative max-w-md space-y-5">
			<div class="inline-flex items-center gap-2 rounded-full border border-border bg-background/60 px-3 py-1 text-xs font-medium backdrop-blur">
				<Crown class="h-3.5 w-3.5 text-primary" />
				<span class="text-muted-foreground">First admin</span>
			</div>
			<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">
				{m.cms_sign_up_description()}
			</h2>
			<p class="text-sm leading-relaxed text-muted-foreground">
				{m.cms_sign_up_only_once()}
			</p>
		</div>

		<p class="relative text-xs text-muted-foreground">
			© {new Date().getFullYear()} Khao Pad. MIT licensed.
		</p>
	</aside>

	<!-- Right: form -->
	<section class="flex flex-col justify-center px-6 py-12 sm:px-12">
		<div class="mx-auto w-full max-w-sm">
			<div class="mb-8 flex items-center gap-2.5 lg:hidden">
				<span
					class="grid h-9 w-9 place-items-center rounded-md bg-primary font-bold text-primary-foreground"
				>
					ข
				</span>
				<span class="text-base font-semibold tracking-tight">Khao Pad</span>
			</div>

			<div class="mb-6">
				<h1 class="text-2xl font-semibold tracking-tight">{m.cms_sign_up()}</h1>
				<p class="mt-1.5 text-sm text-muted-foreground">{m.cms_sign_up_description()}</p>
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
					<div
						class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
					>
						{form.error}
					</div>
				{/if}

				<div class="space-y-1.5">
					<Label for="name">{m.cms_name()}</Label>
					<Input id="name" name="name" required autocomplete="name" />
				</div>

				<div class="space-y-1.5">
					<Label for="email">{m.cms_email()}</Label>
					<Input
						id="email"
						name="email"
						type="email"
						required
						autocomplete="email"
						placeholder="admin@example.com"
					/>
				</div>

				<div class="space-y-1.5">
					<Label for="password">{m.cms_password()}</Label>
					<Input
						id="password"
						name="password"
						type="password"
						required
						minlength={8}
						autocomplete="new-password"
					/>
					<p class="text-xs text-muted-foreground">Minimum 8 characters.</p>
				</div>

				<Button type="submit" disabled={loading} class="w-full">
					{loading ? m.cms_signing_up() : m.cms_sign_up()}
					<ArrowRight class="h-4 w-4" />
				</Button>
			</form>
		</div>
	</section>
</div>
