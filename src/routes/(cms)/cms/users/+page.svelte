<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { formatDate } from '$lib/utils';
	import { Avatar, Badge, Button, Card, Input, Label } from '$lib/components/ui';
	import type { UserRole } from '$lib/server/auth/types';
	import type { PageData } from './$types';

	let {
		data,
		form,
	}: {
		data: PageData;
		form:
			| {
					ok?: boolean;
					error?: string;
					invite?: { token: string; email: string; role: string; expiresAt: string };
			  }
			| null;
	} = $props();

	type Item = (typeof data.items)[number];

	const ROLES: ReadonlyArray<UserRole> = ['super_admin', 'admin', 'editor', 'author'];

	function roleLabel(r: UserRole): string {
		switch (r) {
			case 'super_admin':
				return m.cms_role_super_admin();
			case 'admin':
				return m.cms_role_admin();
			case 'editor':
				return m.cms_role_editor();
			case 'author':
				return m.cms_role_author();
		}
	}

	function roleBadgeVariant(r: UserRole) {
		return r === 'super_admin' || r === 'admin' ? 'default' : 'secondary';
	}

	/**
	 * Mirrors the server-side `canManageUser` rules so the UI doesn't show
	 * controls that the action will reject. Three rules:
	 *   - You can't manage yourself
	 *   - Plain admins can't manage other admins
	 *   - Only super_admins can change a super_admin
	 */
	function canManage(item: Item): boolean {
		if (item.id === data.me.id) return false;
		if (item.role === 'super_admin' && data.me.role !== 'super_admin') return false;
		if (data.me.role === 'admin' && item.role === 'admin') return false;
		return true;
	}

	// Per-row "edit role" toggle so multiple users can be reviewed at once
	// without a global modal.
	let editingId = $state<string | null>(null);
	let pendingRole = $state<UserRole>('author');

	function startEdit(item: Item) {
		editingId = item.id;
		pendingRole = item.role;
	}
	function cancelEdit() {
		editingId = null;
	}

	// Invite form state
	const INVITE_ROLES: ReadonlyArray<'admin' | 'editor' | 'author'> = (
		data.me.role === 'super_admin' ? ['admin', 'editor', 'author'] : ['editor', 'author']
	) as ReadonlyArray<'admin' | 'editor' | 'author'>;
	let inviteEmail = $state('');
	let inviteRole = $state<'admin' | 'editor' | 'author'>('author');
	let inviteCopied = $state(false);

	const origin = $derived(page.url.origin);
	const lastInviteUrl = $derived(
		form?.invite ? `${origin}/cms/invite/${form.invite.token}` : null,
	);

	function buildInviteUrl(token: string) {
		return `${origin}/cms/invite/${token}`;
	}

	async function copyInvite(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			inviteCopied = true;
			setTimeout(() => (inviteCopied = false), 1500);
		} catch {
			// clipboard blocked — fall back to selecting the input
		}
	}
</script>

<svelte:head>
	<title>{m.cms_users()} — {m.cms_app_name()}</title>
</svelte:head>

<section class="mx-auto w-full max-w-4xl">
	<header class="mb-8">
		<h1 class="text-2xl font-semibold tracking-tight">{m.cms_users()}</h1>
		<p class="mt-1.5 text-sm text-muted-foreground">{m.cms_users_help()}</p>
	</header>

	{#if form?.error}
		<div
			class="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
		>
			{form.error}
		</div>
	{/if}

	<!-- Invite form: generates a one-shot signup link with a pre-assigned
	     role. The link itself is the bearer credential — share it via
	     whatever channel makes sense (chat, email). -->
	<Card class="mb-6">
		<div class="space-y-4 p-6">
			<div>
				<h2 class="text-base font-semibold">{m.cms_invite_title()}</h2>
				<p class="mt-1 text-sm text-muted-foreground">{m.cms_invite_help()}</p>
			</div>

			<form
				method="POST"
				action="?/invite"
				class="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end"
				use:enhance={() => {
					return async ({ update }) => {
						await update();
						inviteEmail = '';
					};
				}}
			>
				<div class="space-y-1.5">
					<Label for="invite_email">{m.cms_user_email()}</Label>
					<Input
						id="invite_email"
						name="email"
						type="email"
						bind:value={inviteEmail}
						placeholder="teammate@example.com"
						required
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="invite_role">{m.cms_invite_role()}</Label>
					<select
						id="invite_role"
						name="role"
						bind:value={inviteRole}
						class="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
					>
						{#each INVITE_ROLES as r (r)}
							<option value={r}>{roleLabel(r)}</option>
						{/each}
					</select>
				</div>
				<Button type="submit">{m.cms_invite_generate()}</Button>
			</form>

			{#if lastInviteUrl}
				<div class="rounded-md border border-primary/30 bg-primary/5 p-3">
					<div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
						{m.cms_invite_link_ready()}
					</div>
					<div class="mt-2 flex items-center gap-2">
						<input
							type="text"
							readonly
							value={lastInviteUrl}
							class="flex h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs font-mono"
							onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
						/>
						<Button type="button" size="sm" onclick={() => copyInvite(lastInviteUrl!)}>
							{inviteCopied ? m.cms_invite_copied() : m.cms_invite_copy()}
						</Button>
					</div>
				</div>
			{/if}

			{#if data.invites.length > 0}
				<div class="rounded-md border border-border">
					<div
						class="border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
					>
						{m.cms_invite_pending()}
					</div>
					<ul class="divide-y divide-border">
						{#each data.invites as inv (inv.id)}
							{@const url = buildInviteUrl(inv.token)}
							<li class="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
								<span class="min-w-0 flex-1 truncate">
									<span class="font-medium">{inv.email}</span>
									<span class="ml-2 text-xs text-muted-foreground">
										{roleLabel(inv.role as UserRole)} · expires {formatDate(inv.expiresAt)}
									</span>
								</span>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onclick={() => copyInvite(url)}
								>
									{m.cms_invite_copy()}
								</Button>
								<form
									method="POST"
									action="?/revokeInvite"
									use:enhance={({ cancel }) => {
										if (!confirm(m.cms_invite_revoke_confirm())) {
											cancel();
											return;
										}
										return async ({ update }) => update();
									}}
								>
									<input type="hidden" name="id" value={inv.id} />
									<Button type="submit" size="sm" variant="ghost" class="text-destructive">
										{m.cms_invite_revoke()}
									</Button>
								</form>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</Card>

	<!-- User list -->
	{#if data.items.length === 1}
		<Card>
			<div class="p-6 text-sm text-muted-foreground">{m.cms_users_empty()}</div>
		</Card>
	{:else}
		<Card class="overflow-hidden p-0">
			<ul class="divide-y divide-border">
				{#each data.items as item (item.id)}
					{@const isMe = item.id === data.me.id}
					{@const editable = canManage(item)}
					<li class="flex flex-wrap items-center gap-4 p-4 sm:flex-nowrap">
						<Avatar name={item.name} src={item.image} size="md" />

						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="truncate font-medium text-foreground">{item.name}</span>
								{#if isMe}
									<Badge variant="outline">{m.cms_user_self()}</Badge>
								{/if}
							</div>
							<div class="truncate text-xs text-muted-foreground">{item.email}</div>
							<div class="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
								{m.cms_user_joined()} {formatDate(item.createdAt)}
							</div>
						</div>

						<!-- Role display / edit -->
						{#if editingId === item.id}
							<form
								method="POST"
								action="?/updateRole"
								class="flex items-center gap-2"
								use:enhance={() => {
									return async ({ update }) => {
										await update();
										editingId = null;
									};
								}}
							>
								<input type="hidden" name="id" value={item.id} />
								<select
									name="role"
									bind:value={pendingRole}
									class="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
								>
									{#each ROLES as role (role)}
										{#if role !== 'super_admin' || data.me.role === 'super_admin'}
											<option value={role}>{roleLabel(role)}</option>
										{/if}
									{/each}
								</select>
								<Button type="submit" size="sm">{m.cms_user_role_save()}</Button>
								<Button type="button" size="sm" variant="ghost" onclick={cancelEdit}>
									{m.cms_cancel()}
								</Button>
							</form>
						{:else}
							<Badge variant={roleBadgeVariant(item.role)}>{roleLabel(item.role)}</Badge>
						{/if}

						<!-- Actions -->
						<div class="flex items-center gap-1">
							{#if editable && editingId !== item.id}
								<Button
									type="button"
									size="sm"
									variant="outline"
									onclick={() => startEdit(item)}
								>
									{m.cms_user_change_role()}
								</Button>
								<form
									method="POST"
									action="?/delete"
									use:enhance={({ cancel }) => {
										if (!confirm(m.cms_user_delete_confirm())) {
											cancel();
											return;
										}
										return async ({ update }) => update();
									}}
								>
									<input type="hidden" name="id" value={item.id} />
									<Button type="submit" size="sm" variant="ghost" class="text-destructive">
										{m.cms_user_delete()}
									</Button>
								</form>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</Card>
	{/if}
</section>
