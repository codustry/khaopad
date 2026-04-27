<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { submitEmailLogin } from './login-submit';
	import { Button, Input, Label, Card, CardContent } from '$lib/components/ui';
	import { ArrowRight, Sparkles } from 'lucide-svelte';

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

<div class="grid min-h-screen lg:grid-cols-2">
	<!-- Left: brand panel (desktop only) -->
	<aside
		class="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-sidebar-background p-10 text-sidebar-foreground lg:flex"
	>
		<!-- soft accent shapes -->
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
				<Sparkles class="h-3.5 w-3.5 text-primary" />
				<span class="text-muted-foreground">{m.cms_app_name()}</span>
			</div>
			<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">
				{m.cms_sign_in_description()}
			</h2>
			<p class="text-sm leading-relaxed text-muted-foreground">
				ข้าวผัด — same dish, your sauce. A modular CMS for Cloudflare, multilingual since the first byte.
			</p>
		</div>

		<p class="relative text-xs text-muted-foreground">
			© {new Date().getFullYear()} Khao Pad. MIT licensed.
		</p>
	</aside>

	<!-- Right: form -->
	<section class="flex flex-col justify-center px-6 py-12 sm:px-12">
		<div class="mx-auto w-full max-w-sm">
			<!-- mobile brand -->
			<div class="mb-8 flex items-center gap-2.5 lg:hidden">
				<span
					class="grid h-9 w-9 place-items-center rounded-md bg-primary font-bold text-primary-foreground"
				>
					ข
				</span>
				<span class="text-base font-semibold tracking-tight">Khao Pad</span>
			</div>

			<div class="mb-6">
				<h1 class="text-2xl font-semibold tracking-tight">{m.cms_sign_in()}</h1>
				<p class="mt-1.5 text-sm text-muted-foreground">{m.cms_sign_in_description()}</p>
			</div>

			{#if data.bootstrapNeeded}
				<Card class="mb-5 border-dashed bg-muted/30">
					<CardContent class="p-4">
						<p class="text-sm">
							No admin exists yet.
							<a href="/cms/signup" class="font-medium text-primary underline-offset-4 hover:underline"
								>{m.cms_sign_up()}</a
							>
						</p>
					</CardContent>
				</Card>
			{/if}

			<form onsubmit={handleLogin} class="space-y-4">
				{#if error}
					<div
						class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
					>
						{error}
					</div>
				{/if}

				<div class="space-y-1.5">
					<Label for="email">{m.cms_email()}</Label>
					<Input
						id="email"
						type="email"
						bind:value={email}
						required
						autocomplete="email"
						placeholder="admin@example.com"
					/>
				</div>

				<div class="space-y-1.5">
					<Label for="password">{m.cms_password()}</Label>
					<Input
						id="password"
						type="password"
						bind:value={password}
						required
						autocomplete="current-password"
					/>
				</div>

				<Button type="submit" disabled={loading} class="w-full">
					{loading ? m.cms_signing_in() : m.cms_sign_in()}
					<ArrowRight class="h-4 w-4" />
				</Button>
			</form>
		</div>
	</section>
</div>
