<script lang="ts">
	/**
	 * The single admin page header.
	 *
	 * Replaces 41 hand-rolled `<h1>` blocks that had settled into two
	 * competing weights — 16 pages `font-bold`, 12 `font-semibold` — with
	 * no rule for when to use which. This picks semibold: at 24px, bold
	 * reads as shouting in a dense tool, and semibold holds the hierarchy
	 * just as well against body text.
	 *
	 * Breadcrumbs are a prop rather than derived from the URL. Deriving
	 * them would need a path→label map that duplicates the nav registry
	 * and drifts from it; passing them keeps the label the page's own
	 * business, which matters when the crumb is a record title rather
	 * than a route segment.
	 */
	import { cn } from '$lib/utils';
	import { ChevronRight } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	// `ComponentType`, not `Component`: lucide-svelte still ships legacy
	// component constructors, and this is the same type `sidebar-nav.ts`
	// uses for exactly the same icons.
	import type { ComponentType } from 'svelte';

	export type Crumb = { label: string; href?: string };

	let {
		title,
		description,
		icon: Icon,
		breadcrumbs,
		actions,
		class: className = ''
	}: {
		title: string;
		description?: string;
		icon?: ComponentType;
		breadcrumbs?: Crumb[];
		/** Primary and secondary actions, rendered top-right. */
		actions?: Snippet;
		class?: string;
	} = $props();
</script>

<header class={cn('mb-6', className)}>
	{#if breadcrumbs?.length}
		<!--
			`aria-label` distinguishes this nav from the sidebar nav; without
			it a screen reader announces two unlabelled "navigation" regions.
		-->
		<nav aria-label="Breadcrumb" class="mb-2">
			<ol class="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
				{#each breadcrumbs as crumb, i (crumb.label + i)}
					<li class="flex items-center gap-1">
						{#if i > 0}
							<ChevronRight class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						{/if}
						{#if crumb.href && i < breadcrumbs.length - 1}
							<!--
								The caller passes an already-resolved path — this
								component cannot resolve() a route it does not know at
								compile time, and doing so here would double-resolve.
							-->
							<a
								href={crumb.href}
								class="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
							>
								{crumb.label}
							</a>
						{:else}
							<!-- The last crumb is the current page: not a link, and marked so. -->
							<span aria-current="page" class="text-foreground">{crumb.label}</span>
						{/if}
					</li>
				{/each}
			</ol>
		</nav>
	{/if}

	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="flex min-w-0 items-start gap-3">
			{#if Icon}
				<Icon class="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground" aria-hidden="true" />
			{/if}
			<div class="min-w-0">
				<h1 class="truncate text-2xl font-semibold tracking-tight">{title}</h1>
				{#if description}
					<p class="mt-1 text-sm text-muted-foreground">{description}</p>
				{/if}
			</div>
		</div>

		{#if actions}
			<div class="flex shrink-0 flex-wrap items-center gap-2">
				{@render actions()}
			</div>
		{/if}
	</div>
</header>
