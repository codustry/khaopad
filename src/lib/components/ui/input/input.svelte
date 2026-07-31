<script lang="ts">
	import { cn } from '$lib/utils';
	import type { HTMLInputAttributes } from 'svelte/elements';

	type Props = {
		value?: string | number | null;
		class?: string;
	} & Omit<HTMLInputAttributes, 'class' | 'value'>;

	let { value = $bindable(''), class: className = '', ...rest }: Props = $props();
</script>

<input
	bind:value
	class={cn(
		// Mobile: 44px tall and 16px text.
		//   - h-11 (44px) meets the Apple/Google minimum tap target; h-9 (36px)
		//     did not. WCAG 2.5.8 asks for 24px, platform guidance for 44px.
		//   - text-base (16px) is the threshold below which iOS Safari ZOOMS the
		//     page on focus, then leaves it zoomed — the single most jarring
		//     mobile bug in a form. text-sm (14px) triggered it on every input.
		// Desktop (sm:+) keeps the original denser 36px/14px sizing, where
		// pointer precision makes it comfortable.
		'flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors',
		'sm:h-9 sm:text-sm',
		'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
		'placeholder:text-muted-foreground',
		'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
		'disabled:cursor-not-allowed disabled:opacity-50',
		className,
	)}
	{...rest}
/>
