<script lang="ts">
	type Point = { date: string; count: number };
	let {
		points,
		height = 40,
		width = 240,
	}: { points: Point[]; height?: number; width?: number } = $props();

	// SVG path. We compute lazily in $derived so the component re-renders
	// cleanly when `points` prop changes (e.g. from invalidateAll).
	const max = $derived(Math.max(1, ...points.map((p) => p.count)));
	const stepX = $derived(points.length > 1 ? width / (points.length - 1) : 0);

	const linePath = $derived.by(() => {
		if (points.length === 0) return '';
		return points
			.map((p, i) => {
				const x = i * stepX;
				const y = height - (p.count / max) * (height - 2) - 1;
				return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
			})
			.join(' ');
	});
	const areaPath = $derived.by(() => {
		if (points.length === 0) return '';
		const head = points
			.map((p, i) => {
				const x = i * stepX;
				const y = height - (p.count / max) * (height - 2) - 1;
				return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
			})
			.join(' ');
		return `${head} L ${width} ${height} L 0 ${height} Z`;
	});
</script>

<svg
	{width}
	{height}
	viewBox={`0 0 ${width} ${height}`}
	role="img"
	aria-label="View counts over the last 30 days"
	class="overflow-visible"
>
	{#if areaPath}
		<path d={areaPath} fill="currentColor" opacity="0.1" />
		<path d={linePath} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
	{/if}
</svg>
