<script lang="ts">
	/**
	 * A bar sparkline — "is this steady, spiking, or dying?" at a glance.
	 *
	 * Inline SVG for the same CSP reason as `TrendChart`, and the same
	 * shape as `redblu-siloscale`'s `sparkline.svelte`.
	 *
	 * ## Why zero days are drawn as a hairline
	 *
	 * A day with no views is information — a gap in publishing, a broken
	 * feed, a weekend. Letting it collapse to nothing makes a series with
	 * holes look identical to a shorter series. Upstream calls these
	 * "quiet days" and draws them at the baseline; so does this.
	 */
	let {
		points,
		height = 28,
		label
	}: {
		points: number[];
		height?: number;
		/** Accessible name. Omit only when an adjacent label already says it. */
		label?: string;
	} = $props();

	const max = $derived(Math.max(1, ...points));
	const step = $derived(points.length > 0 ? 100 / points.length : 100);
	const barW = $derived(Math.max(step * 0.7, 0.4));
</script>

{#if points.length > 0}
	<svg
		viewBox="0 0 100 {height}"
		class="block w-full"
		style="height: {height}px"
		preserveAspectRatio="none"
		role={label ? 'img' : 'presentation'}
		aria-label={label}
		aria-hidden={label ? undefined : 'true'}
	>
		{#each points as v, i (i)}
			{@const h = v === 0 ? 0 : Math.max((v / max) * height, 1.5)}
			{#if h > 0}
				<rect x={i * step} y={height - h} width={barW} height={h} rx="0.3" class="fill-primary/70" />
			{:else}
				<!-- Quiet day: a hairline at the baseline, so the gap is visible. -->
				<rect x={i * step} y={height - 1} width={barW} height="1" rx="0.3" class="fill-border" />
			{/if}
		{/each}
	</svg>
{/if}
