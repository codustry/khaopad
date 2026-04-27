<script lang="ts">
	import { page } from '$app/state';
	import { ChevronLeft, LogOut } from 'lucide-svelte';
	import { Avatar, Separator } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import { navGroups, type NavItem } from './sidebar-nav';

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

	function isActive(href: string) {
		// Exact match wins; otherwise treat as section root (e.g. /cms/articles
		// stays active on /cms/articles/new and /cms/articles/[id]).
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
			href="/cms/dashboard"
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
		{#each navGroups as group, i (group.id)}
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
								href={item.href}
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
				<Avatar name={user.name} size="sm" />
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
				<Avatar name={user.name} size="md" />
				<div class="min-w-0 flex-1">
					<div class="truncate text-sm font-medium text-sidebar-foreground">{user.name}</div>
					<div class="truncate text-xs capitalize text-sidebar-foreground/60">
						{user.role.replace('_', ' ')}
					</div>
				</div>
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
