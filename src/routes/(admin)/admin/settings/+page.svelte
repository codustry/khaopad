<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import { Card, CardContent, CardHeader, CardTitle, Input, Label } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		SaveBar,
		DirtyState,
		guardUnsavedChanges
	} from '$lib/components/admin';
	import { Settings } from 'lucide-svelte';
	import type { PageData } from './$types';

	let { data, form }: { data: PageData; form: { ok?: boolean; error?: string } | null } =
		$props();

	// Settings is a singleton (no route params), so `data` can only change via
	// invalidation after our own save — seeding the form once is intended, and
	// re-seeding would clobber in-progress edits.
	// svelte-ignore state_referenced_locally
	let siteName = $state(data.settings.siteName ?? '');
	// svelte-ignore state_referenced_locally
	let defaultLocale = $state<string>(data.settings.defaultLocale);
	// svelte-ignore state_referenced_locally
	let supportedLocales = $state(
		(data.settings.supportedLocales ?? []).join(','),
	);
	// svelte-ignore state_referenced_locally
	let cdnBaseUrl = $state(data.settings.cdnBaseUrl ?? '');
	// svelte-ignore state_referenced_locally
	let cfaToken = $state((data.settings.cfaToken as string | undefined) ?? '');
	// v2.0b newsletter (all optional)
	// svelte-ignore state_referenced_locally
	let newsletterResendKey = $state(
		(data.settings['newsletter.resendKey'] as string | undefined) ?? '',
	);
	// svelte-ignore state_referenced_locally
	let newsletterSender = $state(
		(data.settings['newsletter.senderAddress'] as string | undefined) ?? '',
	);
	// svelte-ignore state_referenced_locally
	let newsletterAllowSingle = $state(
		(data.settings['newsletter.allowSingleOptIn'] as boolean | undefined) ?? true,
	);
	// v2.0c — site-wide comments kill switch. Defaults to false.
	// svelte-ignore state_referenced_locally
	let commentsEnabled = $state(
		(data.settings.commentsEnabled as boolean | undefined) ?? false,
	);
	// v3.16 (C4) — operator email for new-paid-order notifications.
	// svelte-ignore state_referenced_locally
	let shopNotifyEmail = $state(
		(data.settings.shopNotifyEmail as string | undefined) ?? '',
	);
	// v3.17 (D5) — merchant tax identity for the finance report header
	// (ใบกำกับภาษี groundwork).
	// svelte-ignore state_referenced_locally
	let merchantLegalName = $state(
		(data.settings.merchantLegalName as string | undefined) ?? '',
	);
	// svelte-ignore state_referenced_locally
	let merchantTaxId = $state(
		(data.settings.merchantTaxId as string | undefined) ?? '',
	);
	// v3.17 (D6) — design settings: primary color, header logo, hero copy.
	// svelte-ignore state_referenced_locally
	let themePrimaryColor = $state(
		(data.settings.themePrimaryColor as string | undefined) ?? '',
	);
	// svelte-ignore state_referenced_locally
	let themeLogoMediaId = $state(
		(data.settings.themeLogoMediaId as string | undefined) ?? '',
	);
	const heroTitle = (data.settings.homepageHeroTitle ?? {}) as Record<string, string>;
	const heroSubtitle = (data.settings.homepageHeroSubtitle ?? {}) as Record<string, string>;
	let heroTitleEn = $state(heroTitle.en ?? '');
	let heroTitleTh = $state(heroTitle.th ?? '');
	let heroSubtitleEn = $state(heroSubtitle.en ?? '');
	let heroSubtitleTh = $state(heroSubtitle.th ?? '');
	let saving = $state(false);

	// SaveBar + dirty-guard wiring (#160 C8). The snapshot serialises the
	// form's live FormData rather than listing fields by hand, so a field
	// added to this page is tracked automatically — no snapshot edit to
	// forget (which would leave the new field unable to surface the bar).
	let formEl = $state<HTMLFormElement | null>(null);
	const dirty = new DirtyState('');
	function snapshotForm(): string {
		if (!formEl) return '';
		const entries = [...new FormData(formEl).entries()].map(([k, v]) => [
			k,
			typeof v === 'string' ? v : v.name,
		]);
		return JSON.stringify(entries);
	}
	onMount(() => dirty.reset(snapshotForm()));
	guardUnsavedChanges(() => dirty.dirty, m.admin_leave_confirm());
</script>

<svelte:head>
	<title>{m.cms_settings()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="form">
	<PageHeader
		title={m.cms_settings()}
		description={m.cms_settings_help()}
		icon={Settings}
	/>

	<form
		method="POST"
		bind:this={formEl}
		oninput={() => dirty.update(snapshotForm())}
		onchange={() => dirty.update(snapshotForm())}
		use:enhance={() => {
			saving = true;
			dirty.beginSave();
			return async ({ update, result }) => {
				await update();
				saving = false;
				if (result.type === 'success' || result.type === 'redirect') {
					dirty.commit(snapshotForm());
				} else {
					dirty.abortSave();
				}
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

		<Card class="mt-6">
			<CardHeader>
				<CardTitle>{m.cms_settings_newsletter()}</CardTitle>
			</CardHeader>
			<CardContent class="space-y-4">
				<p class="text-xs text-muted-foreground">{m.cms_settings_newsletter_help()}</p>
				<div class="space-y-1.5">
					<Label for="newsletter_resend_key">{m.cms_settings_newsletter_resend_key()}</Label>
					<Input
						id="newsletter_resend_key"
						name="newsletter_resend_key"
						bind:value={newsletterResendKey}
						placeholder="re_..."
						class="font-mono"
					/>
					<p class="text-xs text-muted-foreground">
						{m.cms_settings_newsletter_resend_key_help()}
					</p>
				</div>
				<div class="space-y-1.5">
					<Label for="newsletter_sender">{m.cms_settings_newsletter_sender()}</Label>
					<Input
						id="newsletter_sender"
						name="newsletter_sender"
						bind:value={newsletterSender}
						placeholder="Your Site <hello@yoursite.com>"
					/>
					<p class="text-xs text-muted-foreground">
						{m.cms_settings_newsletter_sender_help()}
					</p>
				</div>
				<label class="flex items-start gap-2 text-sm cursor-pointer">
					<input
						type="checkbox"
						id="newsletter_allow_single_opt_in"
						name="newsletter_allow_single_opt_in"
						bind:checked={newsletterAllowSingle}
						class="mt-0.5 h-4 w-4"
					/>
					<span>
						{m.cms_settings_newsletter_allow_single()}
						<span class="block text-xs text-muted-foreground mt-0.5">
							{m.cms_settings_newsletter_allow_single_help()}
						</span>
					</span>
				</label>
			</CardContent>
		</Card>

		<Card class="mt-6">
			<CardHeader>
				<CardTitle>{m.cms_settings_comments()}</CardTitle>
			</CardHeader>
			<CardContent class="space-y-4">
				<p class="text-xs text-muted-foreground">{m.cms_settings_comments_help()}</p>
				<label class="flex items-start gap-2 text-sm cursor-pointer">
					<input
						type="checkbox"
						id="comments_enabled"
						name="comments_enabled"
						bind:checked={commentsEnabled}
						class="mt-0.5 h-4 w-4"
					/>
					<span>
						{m.cms_settings_comments_enabled()}
						<span class="block text-xs text-muted-foreground mt-0.5">
							{m.cms_settings_comments_enabled_help()}
						</span>
					</span>
				</label>
			</CardContent>
		</Card>

		<!-- v3.16 C4 — plain English; the C6 Thai sweep owns admin i18n. -->
		<Card class="mt-6">
			<CardHeader>
				<CardTitle>Shop notifications</CardTitle>
			</CardHeader>
			<CardContent class="space-y-4">
				<p class="text-xs text-muted-foreground">
					Get notified the moment an order is paid. LINE Notify is configured
					separately under Settings → Secrets (LINE Notify token).
				</p>
				<div class="space-y-1.5">
					<Label for="shop_notify_email">New-order notification email</Label>
					<Input
						id="shop_notify_email"
						name="shop_notify_email"
						type="email"
						bind:value={shopNotifyEmail}
						placeholder="orders@yourshop.com"
					/>
					<p class="text-xs text-muted-foreground">
						Sent via Resend when an order transitions to paid. Leave empty to
						disable the email channel.
					</p>
				</div>
			</CardContent>
		</Card>

		<!-- v3.17 D5 — merchant tax identity, shown on /admin/reports.
		     Plain English like the card above; the Thai admin sweep owns i18n. -->
		<Card class="mt-6">
			<CardHeader>
				<CardTitle>Merchant tax details</CardTitle>
			</CardHeader>
			<CardContent class="space-y-4">
				<p class="text-xs text-muted-foreground">
					Shown on the finance report header — groundwork for Thai tax
					invoices (ใบกำกับภาษี). The full per-order invoice document ships
					later.
				</p>
				<div class="space-y-1.5">
					<Label for="merchant_legal_name">Legal name</Label>
					<Input
						id="merchant_legal_name"
						name="merchant_legal_name"
						bind:value={merchantLegalName}
						placeholder="บริษัท ตัวอย่าง จำกัด"
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="merchant_tax_id">Tax ID (เลขประจำตัวผู้เสียภาษี)</Label>
					<Input
						id="merchant_tax_id"
						name="merchant_tax_id"
						bind:value={merchantTaxId}
						placeholder="0-0000-00000-00-0"
					/>
				</div>
			</CardContent>
		</Card>

		<!-- v3.17 D6 — design settings. Two stores must be able to look
		     different: the color lands on --color-primary via an inline
		     style in the (www) layout; the logo renders in the header;
		     the hero copy replaces the homepage defaults per locale.
		     Plain English like the cards above (Thai sweep owns admin i18n). -->
		<Card class="mt-6">
			<CardHeader>
				<CardTitle>Design</CardTitle>
			</CardHeader>
			<CardContent class="space-y-4">
				<p class="text-xs text-muted-foreground">
					Brand the public site. All fields optional — leave blank to keep
					the built-in look.
				</p>
				<div class="space-y-1.5">
					<Label for="theme_primary_color">Primary color</Label>
					<div class="flex items-center gap-2">
						<input
							type="color"
							aria-label="Primary color picker"
							value={/^#[0-9a-fA-F]{6}$/.test(themePrimaryColor)
								? themePrimaryColor
								: '#1f1f24'}
							oninput={(e) => (themePrimaryColor = e.currentTarget.value)}
							class="h-9 w-12 cursor-pointer rounded-md border border-input bg-transparent p-1"
						/>
						<Input
							id="theme_primary_color"
							name="theme_primary_color"
							bind:value={themePrimaryColor}
							placeholder="#1a73e8"
							class="font-mono"
						/>
					</div>
					<p class="text-xs text-muted-foreground">
						Hex only (#rrggbb). Applied to buttons, links and accents on the
						public site via the --color-primary token.
					</p>
				</div>
				<div class="space-y-1.5">
					<Label for="theme_logo_media_id">Logo media ID</Label>
					<Input
						id="theme_logo_media_id"
						name="theme_logo_media_id"
						bind:value={themeLogoMediaId}
						placeholder="V1StGXR8_Z5jdHi6B-myT"
						class="font-mono"
					/>
					<p class="text-xs text-muted-foreground">
						Paste a media ID from the Media library (use its "Copy ID"
						button) — there is no picker here yet. Shown in the public
						header next to the site name.
					</p>
				</div>
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="space-y-1.5">
						<Label for="hero_title_en">Hero title (EN)</Label>
						<Input id="hero_title_en" name="hero_title_en" bind:value={heroTitleEn} />
					</div>
					<div class="space-y-1.5">
						<Label for="hero_title_th">Hero title (TH)</Label>
						<Input id="hero_title_th" name="hero_title_th" bind:value={heroTitleTh} />
					</div>
					<div class="space-y-1.5">
						<Label for="hero_subtitle_en">Hero subtitle (EN)</Label>
						<Input id="hero_subtitle_en" name="hero_subtitle_en" bind:value={heroSubtitleEn} />
					</div>
					<div class="space-y-1.5">
						<Label for="hero_subtitle_th">Hero subtitle (TH)</Label>
						<Input id="hero_subtitle_th" name="hero_subtitle_th" bind:value={heroSubtitleTh} />
					</div>
				</div>
				<p class="text-xs text-muted-foreground">
					Homepage hero copy per locale. A blank locale falls back to
					English, then to the built-in site name and description.
				</p>
			</CardContent>
		</Card>

		<SaveBar dirty={dirty.dirty} {saving} saveLabel={m.cms_settings_save()} />
	</form>
</PageShell>
