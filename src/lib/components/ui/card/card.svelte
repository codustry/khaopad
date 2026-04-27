<script lang="ts">
	import { cn } from '$lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type Props = { class?: string; children?: Snippet } & Omit<
		HTMLAttributes<HTMLDivElement>,
		'class' | 'children'
	>;

	let { class: className = '', children, ...rest }: Props = $props();
</script>

<div
	class={cn(
		'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
		className,
	)}
	{...rest}
>
	{@render children?.()}
</div>
