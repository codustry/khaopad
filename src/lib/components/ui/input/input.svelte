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
		'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
		'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
		'placeholder:text-muted-foreground',
		'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
		'disabled:cursor-not-allowed disabled:opacity-50',
		className,
	)}
	{...rest}
/>
