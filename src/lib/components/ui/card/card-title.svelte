<script lang="ts">
	import { cn } from '$lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type Props = { class?: string; children?: Snippet } & Omit<
		HTMLAttributes<HTMLHeadingElement>,
		'class' | 'children'
	>;

	let { class: className = '', children, ...rest }: Props = $props();
</script>

<h3
	class={cn('text-lg font-semibold leading-none tracking-tight', className)}
	{...rest}
>
	{@render children?.()}
</h3>
