<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ChevronLeft, LogOut } from 'lucide-svelte';
	import { Avatar, Separator } from '$lib/components/ui';
	import * as m from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';
	import { listNavGroups, type NavItem } from './sidebar-nav';

	type User = { name: string; role: string };

	let { user, onLogout }: { user: User; onLogout?: () => void } = $props();

	// Sidebar collapse state — persist across reloads via localStorage,
	// hydrated on mount to avoid SSR/CSR mismatch.
	let collapsed = $state(false);

	$effect(() => {
		if (typeof window === 'undefined') return;
		try {
			collapsed = localStorage.getItem('khaopad:cms:sidebar:collapsed') === '1';
		} catch {
			// Private mode etc — fall back to expanded.
		}
	});

	function toggleCollapsed() {
		collapsed = !collapsed;
		try {
			localStorage.setItem('khaopad:cms:sidebar:collapsed', collapsed ? '1' : '0');
		} catch {
			// ignore
		}
	}

	const currentPath = $derived(page.url.pathname);

	// Snapshot the registry once per render — plugin boot must complete
	// before the sidebar mounts, which it does since plugins register
	// server-side at module load. Re-reading each render is cheap.
	const groups = $derived(listNavGroups());

	function isActive(href: string) {
		// Exact match wins; otherwise treat as section root (e.g. /admin/articles
		// stays active on /admin/articles/new and /admin/articles/[id]).
		return currentPath === href || currentPath.startsWith(href + '/');
	}

	function visibleItems(items: readonly NavItem[]): NavItem[] {
		return items.filter(
			(it) => !it.roles || (it.roles as readonly string[]).includes(user.role),
		);
	}

	const widthClass = $derived(collapsed ? 'w-[64px]' : 'w-64');
</script>

<aside
	class={cn(
		'flex h-full flex-col border-r border-sidebar-border bg-sidebar-background',
		'transition-[width] duration-200 ease-out',
		widthClass,
	)}
	aria-label="Admin navigation"
>
	<!-- Brand row -->
	<div class="flex h-14 shrink-0 items-center gap-3 border-b border-sidebar-border px-3">
		<a
			href={resolve('/(admin)/admin/dashboard')}
			class="flex min-w-0 items-center gap-2.5 text-sidebar-foreground"
			title="Khao Pad"
		>
			<span
				class="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary font-bold text-primary-foreground"
				aria-hidden="true"
			>
				ข
			</span>
			{#if !collapsed}
				<span class="truncate text-sm font-semibold tracking-tight">Khao Pad</span>
			{/if}
		</a>
		{#if !collapsed}
			<button
				type="button"
				onclick={toggleCollapsed}
				class="ml-auto grid h-7 w-7 place-items-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
				aria-label="Collapse sidebar"
			>
				<ChevronLeft class="h-4 w-4" />
			</button>
		{/if}
	</div>

	<!-- Navigation groups -->
	<nav class="flex-1 overflow-y-auto p-2">
		{#each groups as group, i (group.id)}
			{@const items = visibleItems(group.items)}
			{#if items.length > 0}
				{#if i > 0}
					<div class="my-2 px-2">
						<Separator />
					</div>
				{/if}
				{#if !collapsed}
					<div
						class="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50"
					>
						{group.title()}
					</div>
				{/if}
				<ul class="space-y-0.5">
					{#each items as item (item.href)}
						{@const Icon = item.icon}
						{@const active = isActive(item.href)}
						<li>
							<a
								href={resolve(item.href)}
								title={collapsed ? item.label() : undefined}
								class={cn(
									'flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors',
									active
										? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
										: 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
									collapsed && 'justify-center',
								)}
								aria-current={active ? 'page' : undefined}
							>
								<Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
								{#if !collapsed}
									<span class="truncate">{item.label()}</span>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		{/each}
	</nav>

	<!-- User chip + collapse-to-icon -->
	<div class="border-t border-sidebar-border p-2">
		{#if collapsed}
			<div class="flex flex-col items-center gap-1.5">
				<a
					href={resolve('/(admin)/admin/profile')}
					title={m.cms_profile()}
					aria-label={m.cms_profile()}
					class="rounded-full ring-offset-sidebar-background hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					<Avatar name={user.name} size="sm" />
				</a>
				<button
					type="button"
					onclick={toggleCollapsed}
					class="grid h-7 w-7 place-items-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
					aria-label="Expand sidebar"
				>
					<ChevronLeft class="h-4 w-4 rotate-180" />
				</button>
				{#if onLogout}
					<button
						type="button"
						onclick={onLogout}
						class="grid h-7 w-7 place-items-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
						aria-label="Sign out"
					>
						<LogOut class="h-4 w-4" />
					</button>
				{/if}
			</div>
		{:else}
			<div class="flex items-center gap-2.5 rounded-md p-2">
				<!--
					The chip is the natural place to look for "my account", so it
					links to the self-service profile page. It used to be inert
					text, which left the password-change page undiscoverable even
					once it existed.
				-->
				<a
					href={resolve('/(admin)/admin/profile')}
					title={m.cms_profile()}
					class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Avatar name={user.name} size="md" />
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium text-sidebar-foreground">{user.name}</div>
						<div class="truncate text-xs capitalize text-sidebar-foreground/60">
							{user.role.replace('_', ' ')}
						</div>
					</div>
				</a>
				{#if onLogout}
					<button
						type="button"
						onclick={onLogout}
						class="grid h-7 w-7 place-items-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
						aria-label="Sign out"
						title="Sign out"
					>
						<LogOut class="h-4 w-4" />
					</button>
				{/if}
			</div>
		{/if}
	</div>
</aside>
