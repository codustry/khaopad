<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import {
		Button,
		Card,
		CardContent,
		CardHeader,
		CardTitle,
		Input,
		Label
	} from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import { UserCircle } from 'lucide-svelte';
	import type { PageData } from './$types';

	type ActionResult = {
		ok?: boolean;
		error?: string;
		changed?: 'password' | 'profile';
	} | null;

	let { data, form }: { data: PageData; form: ActionResult } = $props();

	// Seeded once: `data` only changes after our own save invalidates it,
	// and re-seeding mid-edit would clobber in-progress typing.
	// svelte-ignore state_referenced_locally
	let name = $state(data.profile.name);
	// svelte-ignore state_referenced_locally
	let image = $state(data.profile.image ?? '');

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let savingProfile = $state(false);
	let savingPassword = $state(false);

	// Convenience only — the action re-checks this. A client-side guard
	// cannot be a security control, it just saves a round trip.
	const mismatch = $derived(
		confirmPassword.length > 0 && newPassword !== confirmPassword
	);
	const canSubmitPassword = $derived(
		currentPassword.length > 0 && newPassword.length >= 8 && !mismatch
	);
</script>

<svelte:head>
	<title>{m.cms_profile()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="form">
	<PageHeader
		title={m.cms_profile()}
		description={m.cms_profile_help()}
		icon={UserCircle}
	/>

	{#if form?.error}
		<div
			class="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
			role="alert"
		>
			{form.error}
		</div>
	{/if}
	{#if form?.ok}
		<div
			class="mb-6 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm text-foreground"
			role="status"
		>
			{form.changed === 'password' ? m.cms_password_changed() : m.cms_profile_saved()}
		</div>
	{/if}

	<div class="space-y-6">
		<!-- Details -->
		<Card>
			<CardHeader>
				<CardTitle>{m.cms_profile_details()}</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					method="POST"
					action="?/updateProfile"
					class="space-y-6"
					use:enhance={() => {
						savingProfile = true;
						return async ({ update }) => {
							await update();
							savingProfile = false;
						};
					}}
				>
					<div class="space-y-1.5">
						<Label for="name">{m.cms_profile_name()}</Label>
						<Input id="name" name="name" bind:value={name} required maxlength={120} />
					</div>

					<div class="space-y-1.5">
						<Label for="image">{m.cms_profile_image()}</Label>
						<Input
							id="image"
							name="image"
							bind:value={image}
							placeholder="https://example.com/avatar.png"
						/>
						<p class="text-xs text-muted-foreground">{m.cms_profile_image_help()}</p>
					</div>

					<!--
						Email is read-only by design: changing it under Better Auth
						requires the `changeEmail` verification flow, and this
						deployment treats transactional email as optional.
					-->
					<div class="space-y-1.5">
						<Label for="email">{m.cms_profile_email()}</Label>
						<Input id="email" value={data.profile.email} readonly disabled />
						<p class="text-xs text-muted-foreground">{m.cms_profile_email_help()}</p>
					</div>

					<div class="space-y-1.5">
						<Label for="role">{m.cms_profile_role()}</Label>
						<Input
							id="role"
							value={data.profile.role.replace('_', ' ')}
							readonly
							disabled
							class="capitalize"
						/>
					</div>

					<Button type="submit" disabled={savingProfile}>
						{m.cms_save()}
					</Button>
				</form>
			</CardContent>
		</Card>

		<!-- Password -->
		<Card>
			<CardHeader>
				<CardTitle>{m.cms_password()}</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					method="POST"
					action="?/changePassword"
					class="space-y-6"
					use:enhance={() => {
						savingPassword = true;
						return async ({ update, result }) => {
							await update({ reset: false });
							savingPassword = false;
							if (result.type === 'success') {
								currentPassword = '';
								newPassword = '';
								confirmPassword = '';
							}
						};
					}}
				>
					<p class="text-sm text-muted-foreground">{m.cms_password_help()}</p>

					<div class="space-y-1.5">
						<Label for="currentPassword">{m.cms_password_current()}</Label>
						<Input
							id="currentPassword"
							name="currentPassword"
							type="password"
							autocomplete="current-password"
							bind:value={currentPassword}
							required
						/>
					</div>

					<div class="space-y-1.5">
						<Label for="newPassword">{m.cms_password_new()}</Label>
						<Input
							id="newPassword"
							name="newPassword"
							type="password"
							autocomplete="new-password"
							minlength={8}
							bind:value={newPassword}
							required
						/>
						<p class="text-xs text-muted-foreground">{m.cms_password_new_help()}</p>
					</div>

					<div class="space-y-1.5">
						<Label for="confirmPassword">{m.cms_password_confirm()}</Label>
						<Input
							id="confirmPassword"
							name="confirmPassword"
							type="password"
							autocomplete="new-password"
							bind:value={confirmPassword}
							required
						/>
						{#if mismatch}
							<p class="text-xs text-destructive">{m.cms_password_mismatch()}</p>
						{/if}
					</div>

					<Button type="submit" disabled={savingPassword || !canSubmitPassword}>
						{m.cms_password_change_action()}
					</Button>
				</form>
			</CardContent>
		</Card>
	</div>
</PageShell>
