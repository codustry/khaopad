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
	 */
	export type ShellWidth = 'form' | 'default' | 'wide' | 'full';

	const WIDTHS: Record<ShellWidth, string> = {
		form: 'max-w-2xl',
		default: 'max-w-5xl',
		wide: 'max-w-7xl',
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
