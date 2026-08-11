<script lang="ts">
	import { resolve } from '$app/paths';
	import '../../../app.css';
	import { goto } from '$app/navigation';
	import { Menu, X } from 'lucide-svelte';
	import Sidebar from '$lib/components/admin/Sidebar.svelte';
	import AdminLocaleToggle from '$lib/components/admin/AdminLocaleToggle.svelte';
	import ThemeToggle from '$lib/components/admin/ThemeToggle.svelte';
	import CommandPalette from '$lib/components/admin/CommandPalette.svelte';
	import { theme } from '$lib/components/admin/theme.svelte';
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let {
		children,
		data,
	}: {
		children: Snippet;
		data: LayoutData;
	} = $props();

	let mobileOpen = $state(false);

	// Picks up the stored preference and follows OS changes while mounted.
	// The pre-paint class is set by the inline script in app.html; this
	// takes over ownership after hydration.
	onMount(() => theme.init());

	async function logout() {
		try {
			await fetch('/api/auth/sign-out', { method: 'POST' });
		} catch {
			// network failure: still try to leave
		}
		goto(resolve('/(admin)/admin/login'), { invalidateAll: true });
	}

	// Re-derived per page so the sidebar sees route changes for active state.
	// data.user is null on the public-ish auth pages (login/signup).

	/**
	 * Global ⌘S / Ctrl+S (#160 C8).
	 *
	 * Mechanism: query the visible SaveBar's submit button and click it,
	 * rather than dispatching a CustomEvent each SaveBar subscribes to.
	 * Why: the SaveBar only renders while its form is dirty, so
	 * "querySelector found a [data-savebar-submit]" is already the exact
	 * "there is something to save" predicate — an event bus would make
	 * every SaveBar instance re-implement that same visibility check in
	 * a listener it must add and remove. Clicking the real button also
	 * reuses the form's own submit path (`use:enhance`, `form=` id
	 * associations, disabled-while-saving) for free.
	 *
	 * preventDefault fires unconditionally: even with nothing to save,
	 * the browser's "save this web page" dialog is never what an admin
	 * wants.
	 */
	function onGlobalKeydown(event: KeyboardEvent) {
		if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
		if (event.key.toLowerCase() !== 's') return;
		event.preventDefault();
		document.querySelector<HTMLButtonElement>('[data-savebar-submit]')?.click();
	}
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

{#if !data.user}
	<!-- Auth pages (login / signup) render full-bleed without the shell. -->
	{@render children()}
{:else}
	<div class="flex min-h-screen bg-background">
		<!--
			Desktop sidebar (lg+).

			Sticky to the viewport so long pages (settings, audit log,
			navigation manager, history timeline, etc.) scroll their
			content while the nav stays visible. `h-screen` clamps to
			the viewport; `lg:sticky lg:top-0` keeps it pinned. The
			inner <aside> is already `h-full` so it fills exactly that
			height.
		-->
		<div class="hidden shrink-0 lg:block lg:sticky lg:top-0 lg:h-screen">
			<Sidebar user={data.user} onLogout={logout} />
		</div>

		<!-- Mobile drawer -->
		{#if mobileOpen}
			<div
				class="fixed inset-0 z-40 bg-black/50 lg:hidden"
				onclick={() => (mobileOpen = false)}
				role="presentation"
			></div>
			<div
				class="fixed inset-y-0 left-0 z-50 lg:hidden"
				role="dialog"
				aria-modal="true"
				aria-label="Navigation"
			>
				<Sidebar user={data.user} onLogout={logout} />
			</div>
		{/if}

		<!-- Main column -->
		<div class="flex min-w-0 flex-1 flex-col">
			<!-- Topbar -->
			<header
				class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-sm sm:px-6"
			>
				<button
					type="button"
					onclick={() => (mobileOpen = !mobileOpen)}
					class="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground lg:hidden"
					aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
				>
					{#if mobileOpen}
						<X class="h-4 w-4" />
					{:else}
						<Menu class="h-4 w-4" />
					{/if}
				</button>

				<div class="flex-1"></div>

				<ThemeToggle />
				<AdminLocaleToggle />
			</header>

			<!--
				Page content. Padding and max-width belong to <PageShell>,
				which every page wraps its content in — applying them here
				too would double the padding on all 41 pages.
			-->
			<main class="flex-1">
				{@render children()}
			</main>

			<!-- ⌘K. Reads the same nav registry the sidebar does. -->
			<CommandPalette role={data.user.role} />

		</div>
	</div>
{/if}
