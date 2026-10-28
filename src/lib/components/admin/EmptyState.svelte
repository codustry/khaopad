<script lang="ts">
	/**
	 * "Nothing here yet" — said in a way that does not read as "broken".
	 *
	 * ## Why this is a component
	 *
	 * On a fresh install the dashboard had eight panels, six of them
	 * empty, and every one of them said its piece in the same flat
	 * `text-sm text-muted-foreground` used for real content. A panel with
	 * one grey sentence in it is indistinguishable from a panel that
	 * failed to load, so the first screen a new operator ever sees looks
	 * like a failed installation.
	 *
	 * The upstream Codustry dashboards settle this with an explicit
	 * `.empty` treatment (see `khaopad-telemetry`'s `styles.ts`): a
	 * DASHED border, so the shape reads as a placeholder rather than a
	 * container that came up blank; a bold line naming what will appear
	 * here; and one sentence on how to make it appear.
	 *
	 * The dashed border is doing real work. A solid border is the same
	 * affordance as a populated card, which is exactly the confusion.
	 *
	 * ## Empty is not error
	 *
	 * This is only for "no data yet". A panel whose query FAILED must not
	 * use this — telling someone to go publish an article when the
	 * database is unreachable sends them to fix the wrong thing.
	 */
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		/** A primary action, when there is an obvious next step. */
		action,
		/** `sm` for inside a card body, `md` standalone. */
		size = 'md',
		class: className = ''
	}: {
		title: string;
		description?: string;
		action?: Snippet;
		size?: 'sm' | 'md';
		class?: string;
	} = $props();
</script>

<div
	class={cn(
		'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center',
		size === 'sm' ? 'px-4 py-6' : 'px-4 py-8',
		className
	)}
>
	<strong class="text-sm font-medium text-foreground">{title}</strong>
	{#if description}
		<p class="max-w-[42ch] text-xs leading-relaxed text-muted-foreground">
			{description}
		</p>
	{/if}
	{#if action}
		<div class="mt-1">{@render action()}</div>
	{/if}
</div>
