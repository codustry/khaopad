<script lang="ts">
	import '../../../app.css';
	import { goto } from '$app/navigation';
	import { Menu, X } from 'lucide-svelte';
	import Sidebar from '$lib/components/cms/Sidebar.svelte';
	import CmsLocaleToggle from '$lib/components/cms/CmsLocaleToggle.svelte';
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

	async function logout() {
		try {
			await fetch('/api/auth/sign-out', { method: 'POST' });
		} catch {
			// network failure: still try to leave
		}
		goto('/cms/login', { invalidateAll: true });
	}

	// Re-derived per page so the sidebar sees route changes for active state.
	// data.user is null on the public-ish auth pages (login/signup).
</script>

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

				<CmsLocaleToggle />
			</header>

			<!-- Page content -->
			<main class="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
				{@render children()}
			</main>
		</div>
	</div>
{/if}
