<script lang="ts">
	import { cn } from '$lib/utils';

	type Props = {
		name: string;
		src?: string | null;
		size?: 'sm' | 'md' | 'lg';
		class?: string;
	};

	let { name, src = null, size = 'md', class: className = '' }: Props = $props();

	const initials = $derived(
		name
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((n) => n[0]?.toUpperCase() ?? '')
			.join('') || '?',
	);

	const sizeClass = $derived(
		size === 'sm'
			? 'h-7 w-7 text-[10px]'
			: size === 'lg'
				? 'h-10 w-10 text-sm'
				: 'h-8 w-8 text-xs',
	);

	let imgFailed = $state(false);
</script>

<span
	class={cn(
		'inline-flex items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground select-none',
		sizeClass,
		className,
	)}
	aria-label={name}
>
	{#if src && !imgFailed}
		<img
			{src}
			alt={name}
			class="h-full w-full object-cover"
			onerror={() => (imgFailed = true)}
		/>
	{:else}
		<span>{initials}</span>
	{/if}
</span>
