<script lang="ts" module>
	/**
	 * A daily-series area chart, drawn as inline SVG.
	 *
	 * ## Why not a charting library
	 *
	 * The admin runs under a strict CSP: `default-src 'self'` and
	 * `script-src 'self'` (see `svelte.config.js`). Any CDN-hosted chart
	 * library is a new script origin, and this codebase has already paid
	 * for underestimating that policy — the admin's webfont was silently
	 * blocked for weeks because `fonts.googleapis.com` was missing from
	 * `style-src`, with no error on the page and only a console warning.
	 * A chart is not worth loosening the policy that closes a stored-XSS
	 * hole, and this chart is ~80 lines.
	 *
	 * Same reasoning as `khaopad-telemetry`'s `charts.ts`, which draws
	 * the equivalent chart server-side for the same reason.
	 *
	 * ## Why no tick marks and no axis baseline
	 *
	 * Three horizontal gridlines (0, mid, max) carry the scale. An axis
	 * spine and per-day ticks add ink without adding information, and on
	 * a 30-point series the tick labels collide on a phone — so only the
	 * first, middle and last dates are labelled.
	 *
	 * ## Colour
	 *
	 * Every stroke and fill is a semantic token, so light/dark needs no
	 * second set of markup.
	 */
	export type TrendPoint = { date: string; count: number };

	/** Round a max up to a readable ceiling so gridline labels are round. */
	export function niceCeil(max: number): number {
		if (max <= 1) return 1;
		const mag = Math.pow(10, Math.floor(Math.log10(max)));
		for (const m of [1, 2, 2.5, 5, 10]) {
			const c = m * mag;
			if (c >= max) return c;
		}
		return 10 * mag;
	}

	/** 2dp, so the emitted path data stays short and diffable. */
	const n2 = (n: number) => Math.round(n * 100) / 100;
</script>

<script lang="ts">
	let {
		points,
		label,
		height = 160
	}: {
		points: TrendPoint[];
		/** Accessible name — the chart is an image to a screen reader. */
		label: string;
		height?: number;
	} = $props();

	// Fixed viewBox, scaled fluidly by CSS width. Responsive without JS.
	const W = 720;
	const padL = 34;
	const padR = 8;
	const padT = 12;
	const padB = 22;

	const H = $derived(height);
	const iw = W - padL - padR;
	const ih = $derived(H - padT - padB);

	const ceil = $derived(niceCeil(Math.max(1, ...points.map((p) => p.count))));
	const x = $derived((i: number) =>
		points.length === 1 ? padL + iw / 2 : padL + (i / (points.length - 1)) * iw
	);
	const y = $derived((v: number) => padT + ih - (v / ceil) * ih);

	const line = $derived(
		points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n2(x(i))} ${n2(y(p.count))}`).join(' ')
	);
	const area = $derived(
		points.length === 0
			? ''
			: `${line} L${n2(x(points.length - 1))} ${n2(padT + ih)} L${n2(x(0))} ${n2(padT + ih)} Z`
	);

	const gridValues = $derived([0, ceil / 2, ceil]);
	// First, middle, last only — more labels collide at phone width.
	const tickIdx = $derived([
		...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])
	]);

	/** `2026-09-05` → `09-05`; the year is constant across the window. */
	const shortDate = (d: string) => d.slice(5);
</script>

{#if points.length > 0}
	<svg
		viewBox="0 0 {W} {H}"
		class="block w-full overflow-visible"
		style="height: {H}px"
		role="img"
		aria-label={label}
		preserveAspectRatio="none"
	>
		<g>
			{#each gridValues as v (v)}
				<line
					x1={padL}
					y1={n2(y(v))}
					x2={W - padR}
					y2={n2(y(v))}
					class="stroke-border"
					stroke-opacity="0.6"
				/>
				<!--
					`vector-effect` keeps the label legible: the SVG is stretched
					horizontally by preserveAspectRatio="none", which would
					otherwise smear the text with it.
				-->
				<text
					x={padL - 6}
					y={n2(y(v) + 3.5)}
					text-anchor="end"
					class="fill-muted-foreground text-[10px]"
				>
					{v}
				</text>
			{/each}
		</g>

		<path d={area} class="fill-primary/15" />
		<path
			d={line}
			class="stroke-primary"
			fill="none"
			stroke-width="2"
			stroke-linejoin="round"
			stroke-linecap="round"
			vector-effect="non-scaling-stroke"
		/>

		<g>
			{#each tickIdx as i (i)}
				<text
					x={n2(x(i))}
					y={H - 6}
					text-anchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
					class="fill-muted-foreground text-[10px]"
				>
					{shortDate(points[i].date)}
				</text>
			{/each}
		</g>
	</svg>
{/if}
