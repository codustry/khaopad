<script lang="ts">
	import '../../app.css';
	import * as m from '$lib/paraglide/messages';
	import { cmsHref } from '$lib/cms-href';
	import { resolve } from '$app/paths';
	let { children, data } = $props();
</script>

{#if !data.user}
	{@render children()}
{:else}
	<div class="min-h-screen flex">
		<!-- Sidebar -->
		<aside class="w-64 border-r border-border bg-sidebar-background p-4 flex flex-col">
			<div class="mb-8">
				<h1 class="text-lg font-bold">{m.cms_app_name()}</h1>
			</div>
			<nav class="flex-1 space-y-1">
				<a href={resolve('/dashboard')} class="block px-3 py-2 rounded-md hover:bg-sidebar-accent text-sm">
					{m.cms_dashboard()}
				</a>
				<a href={resolve('/articles')} class="block px-3 py-2 rounded-md hover:bg-sidebar-accent text-sm">
					{m.cms_articles()}
				</a>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved in $lib/cms-href -->
				<a href={cmsHref.media} class="block px-3 py-2 rounded-md hover:bg-sidebar-accent text-sm">
					{m.cms_media()}
				</a>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved in $lib/cms-href -->
				<a href={cmsHref.categories} class="block px-3 py-2 rounded-md hover:bg-sidebar-accent text-sm">
					{m.cms_categories()}
				</a>
				{#if data.user.role === 'super_admin' || data.user.role === 'admin'}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved in $lib/cms-href -->
					<a href={cmsHref.users} class="block px-3 py-2 rounded-md hover:bg-sidebar-accent text-sm">
						{m.cms_users()}
					</a>
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved in $lib/cms-href -->
					<a href={cmsHref.settings} class="block px-3 py-2 rounded-md hover:bg-sidebar-accent text-sm">
						{m.cms_settings()}
					</a>
				{/if}
			</nav>
			<div class="text-xs text-muted-foreground pt-4 border-t border-border">
				<p>{data.user.name}</p>
				<p class="capitalize">{data.user.role.replace('_', ' ')}</p>
			</div>
		</aside>

		<!-- Main content -->
		<main class="flex-1 p-8">
			{@render children()}
		</main>
	</div>
{/if}
