<script lang="ts" module>
	/**
	 * The one padding scale and the one max-width for admin pages.
	 *
	 * Before this existed, 41 pages picked their own: five padding scales
	 * (`p-3` ×25, `p-6` ×19, `p-4` ×16, `p-8` ×11, `p-2` ×2) and six
	 * max-widths (`4xl` ×9, `3xl` ×7, `md` ×3, `5xl` ×3, `2xl` ×3, `sm` ×2).
	 * That spread is why pages felt subtly different from one another even
	 * when each looked fine in isolation.
	 *
	 * ## Why these widths
	 *
	 * Sized for a single operator or small team — comfortable density,
	 * not a 20-editor newsroom's compact scale. Tightening a comfortable
	 * scale later is a token change; loosening a compact one is a
	 * redesign, so this is the safer direction to default to.
	 *
	 * `form` is ~672px, close to Polaris's 662px primary column: a
	 * measure of roughly 75 characters, past which the eye loses the line
	 * on the return sweep. `wide` is for data tables, which want the
	 * horizontal room. `full` opts out for editors that manage their own
	 * layout (the split markdown preview, for one).
	 *
	 * ## Why `wide` and `default` are no longer fixed caps (#195)
	 *
	 * A downstream measured the previous caps against real monitors: at
	 * 1920px the `wide` dashboard left 384px (23%) of the available area
	 * empty, and `default` wasted 640px (38%); at 2560px `wide` wasted
	 * 44%. Nineteen pages are data tables that scroll horizontally
	 * INSIDE a container itself short of the window — columns truncated
	 * next to blank screen. A cap measured in pixels cannot follow a
	 * viewport, so the two layout widths now scale with it:
	 *
	 *   wide     → fills the available width outright. Tables want every
	 *              pixel; there is no reading measure to protect.
	 *   default  → tracks the viewport but stops at 96rem, so mixed
	 *              content (cards + prose + a table) grows on a 1920px
	 *              screen without turning body copy into a 1600px line.
	 *
	 * `form` deliberately stays a FIXED `max-w-2xl`. It is the one width
	 * protecting a reading measure: a single-column form stretched to
	 * 1664px is materially worse than the whitespace beside it. The 60%
	 * "waste" the issue measures for `form` at 1920px is the feature.
	 */
	export type ShellWidth = 'form' | 'default' | 'wide' | 'full';

	const WIDTHS: Record<ShellWidth, string> = {
		// Fixed: protects the ~75-character measure. See the note above
		// before "fixing" this one — it is intentional.
		form: 'max-w-2xl',
		// Fluid to 96rem (1536px): grows on wide monitors, still stops
		// body copy short of an unreadable line length.
		default: 'max-w-[96rem]',
		// Uncapped: data tables take the whole available width.
		wide: 'max-w-none',
		full: 'max-w-none'
	};
</script>

<script lang="ts">
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';

	let {
		width = 'default',
		class: className = '',
		children
	}: {
		width?: ShellWidth;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<!--
	Padding steps up with the viewport rather than staying fixed: 16px on
	a phone, where every pixel of content width counts, to 32px on a
	desktop, where edge-to-edge text is uncomfortable to read.

	No `mx-auto`: the max-width container hugs the left content edge,
	right after the sidebar. Centering it in the leftover viewport put a
	~500px dead gap between the sidebar and a `form`-width page on a
	2000px screen — the eye had to travel from the nav, across nothing,
	to the content. Left-aligned, the reading edge stays anchored next
	to the sidebar at every viewport and every ShellWidth.
-->
<div class={cn('w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8', WIDTHS[width], className)}>
	{@render children()}
</div>
