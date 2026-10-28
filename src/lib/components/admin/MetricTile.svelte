<script lang="ts" module>
	/**
	 * One number on a dashboard.
	 *
	 * Ported from the tile the other Codustry dashboards share
	 * (`redblu-siloscale`'s `metric-tile.svelte`, and the `.kpi` rules in
	 * `khaopad-telemetry`'s `styles.ts`). Deliberately the same shape:
	 * xs muted label, large semibold tabular number, xs hint underneath.
	 *
	 * ## Why `tone` colours the number and not the tile
	 *
	 * Both upstream implementations carry this comment, and it is the
	 * whole reason this is a component rather than a div. A tinted card
	 * makes every tile shout at the same volume, which is the same
	 * failure as no emphasis at all — the eye has nowhere to land. Only
	 * the digits take the colour.
	 *
	 * ## Why `null` is not `0`
	 *
	 * `value={null}` renders an em dash and a short "no data yet" rather
	 * than a zero. Drawing an unknown as zero asserts something that is
	 * not in evidence: "nobody has visited" and "we have not measured"
	 * look identical as `0`, and only one of them is a reason to worry.
	 * This is the same distinction the upstream tile draws with its
	 * `unknownLabel` prop.
	 */
	export type MetricTone = 'neutral' | 'good' | 'warn' | 'bad';

	/**
	 * Tone → text colour. Semantic tokens only, so dark mode inverts
	 * with the rest of the admin rather than staying a light-mode wash.
	 */
	const TONES: Record<MetricTone, string> = {
		neutral: 'text-foreground',
		good: 'text-green-600 dark:text-green-400',
		warn: 'text-amber-600 dark:text-amber-400',
		bad: 'text-destructive'
	};
</script>

<script lang="ts">
	import { cn } from '$lib/utils';
	import * as m from '$lib/paraglide/messages';
	import type { Snippet } from 'svelte';

	let {
		label,
		value,
		unit,
		hint,
		tone = 'neutral',
		/** Emphasised tile: accent border and a larger number. One per row. */
		lead = false,
		unknownLabel,
		href,
		children,
		class: className = ''
	}: {
		label: string;
		/** `null` means "not measured" — rendered as `—`, never as 0. */
		value: string | number | null;
		unit?: string;
		hint?: string;
		tone?: MetricTone;
		lead?: boolean;
		unknownLabel?: string;
		/** Makes the whole tile a link. Gets a focus ring and hover border. */
		href?: string;
		/** Extra content below the hint — a sparkline, usually. */
		children?: Snippet;
		class?: string;
	} = $props();

	const isUnknown = $derived(value === null || value === undefined);
</script>

<!--
	`svelte:element` so the tile is an <a> when it links somewhere and a
	plain <div> when it does not — rather than an <a href="#"> or a div
	with a click handler, neither of which a keyboard reaches correctly.
-->
<svelte:element
	this={href ? 'a' : 'div'}
	href={href || undefined}
	class={cn(
		'flex flex-col gap-1 rounded-lg border bg-card p-3',
		lead ? 'border-primary/40' : 'border-border',
		href &&
			'transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
		className
	)}
>
	<span class="text-xs font-medium text-muted-foreground">{label}</span>

	{#if isUnknown}
		<span class="flex items-baseline gap-1.5">
			<span
				class={cn(
					'font-semibold leading-tight text-muted-foreground',
					lead ? 'text-3xl' : 'text-2xl'
				)}>—</span
			>
			<span class="text-xs text-muted-foreground">
				{unknownLabel ?? m.cms_metric_no_data()}
			</span>
		</span>
	{:else}
		<span class="flex items-baseline gap-1">
			<span
				class={cn(
					'font-semibold leading-tight tracking-tight tabular-nums',
					TONES[tone],
					lead ? 'text-3xl' : 'text-2xl'
				)}>{value}</span
			>
			{#if unit}
				<span class="text-xs text-muted-foreground">{unit}</span>
			{/if}
		</span>
	{/if}

	{#if hint}
		<span class="text-xs leading-snug text-muted-foreground">{hint}</span>
	{/if}
	{#if children}
		{@render children()}
	{/if}
</svelte:element>
