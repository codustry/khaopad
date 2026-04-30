<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '$lib/components/ui';
	import type { PageData } from './$types';

	let { data, form }: { data: PageData; form: { ok?: boolean; error?: string } | null } =
		$props();

	let siteName = $state(data.settings.siteName ?? '');
	let defaultLocale = $state<string>(data.settings.defaultLocale);
	let supportedLocales = $state(
		(data.settings.supportedLocales ?? []).join(','),
	);
	let cdnBaseUrl = $state(data.settings.cdnBaseUrl ?? '');
	let cfaToken = $state((data.settings.cfaToken as string | undefined) ?? '');
	let saving = $state(false);
</script>

<svelte:head>
	<title>{m.cms_settings()} — {m.cms_app_name()}</title>
</svelte:head>

<section class="mx-auto w-full max-w-2xl">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">{m.cms_settings()}</h1>
		<p class="mt-1.5 text-sm text-muted-foreground">{m.cms_settings_help()}</p>
	</header>

	<form
		method="POST"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update();
				saving = false;
			};
		}}
	>
		{#if form?.error}
			<div
				class="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
			>
				{form.error}
			</div>
		{/if}
		{#if form?.ok}
			<div
				class="mb-6 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm text-foreground"
			>
				{m.cms_settings_saved()}
			</div>
		{/if}

		<Card>
			<CardHeader>
				<CardTitle>{m.cms_settings()}</CardTitle>
			</CardHeader>
			<CardContent class="space-y-6">
				<div class="space-y-1.5">
					<Label for="site_name">{m.cms_settings_site_name()}</Label>
					<Input id="site_name" name="site_name" bind:value={siteName} required />
					<p class="text-xs text-muted-foreground">{m.cms_settings_site_name_help()}</p>
				</div>

				<div class="space-y-1.5">
					<Label for="default_locale">{m.cms_settings_default_locale()}</Label>
					<select
						id="default_locale"
						name="default_locale"
						bind:value={defaultLocale}
						class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
					>
						<option value="en">English (en)</option>
						<option value="th">ไทย (th)</option>
					</select>
					<p class="text-xs text-muted-foreground">{m.cms_settings_default_locale_help()}</p>
				</div>

				<div class="space-y-1.5">
					<Label for="supported_locales">{m.cms_settings_supported_locales()}</Label>
					<Input
						id="supported_locales"
						name="supported_locales"
						bind:value={supportedLocales}
						placeholder="en,th"
					/>
					<p class="text-xs text-muted-foreground">{m.cms_settings_supported_locales_help()}</p>
				</div>

				<div class="space-y-1.5">
					<Label for="cdn_base_url">{m.cms_settings_cdn_base_url()}</Label>
					<Input
						id="cdn_base_url"
						name="cdn_base_url"
						bind:value={cdnBaseUrl}
						placeholder="https://cdn.example.com"
					/>
					<p class="text-xs text-muted-foreground">{m.cms_settings_cdn_base_url_help()}</p>
				</div>

				<div class="space-y-1.5">
					<Label for="cfa_token">{m.cms_settings_cfa_token()}</Label>
					<Input
						id="cfa_token"
						name="cfa_token"
						bind:value={cfaToken}
						placeholder="abc123…"
						class="font-mono"
					/>
					<p class="text-xs text-muted-foreground">{m.cms_settings_cfa_token_help()}</p>
				</div>
			</CardContent>
		</Card>

		<div class="mt-6 flex justify-end">
			<Button type="submit" disabled={saving}>
				{saving ? m.cms_saving() : m.cms_settings_save()}
			</Button>
		</div>
	</form>
</section>
