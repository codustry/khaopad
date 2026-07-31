<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const buttonVariants = tv({
		base: "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground hover:bg-primary/90',
				destructive:
					'bg-destructive text-destructive-foreground hover:bg-destructive/90',
				outline:
					'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-secondary/80',
				ghost: 'hover:bg-accent hover:text-accent-foreground',
				link: 'text-primary underline-offset-4 hover:underline',
			},
			// Mobile-first sizing: 44px tall on touch, denser on desktop (sm:+).
			// 44px is the Apple/Google minimum tap target; the previous 36px
			// (h-9) missed it on every primary action, and icon buttons at
			// 36x36 were the hardest to hit accurately.
			size: {
				default: 'h-11 px-4 py-2 sm:h-9',
				sm: 'h-9 rounded-md px-3 text-xs sm:h-8',
				lg: 'h-12 rounded-md px-6 sm:h-10',
				icon: 'h-11 w-11 sm:h-9 sm:w-9',
			},
		},
		defaultVariants: { variant: 'default', size: 'default' },
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];
</script>

<script lang="ts">
	import { cn } from '$lib/utils';
	import type { HTMLButtonAttributes, HTMLAnchorAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type Props =
		| ({
				href: string;
				variant?: ButtonVariant;
				size?: ButtonSize;
				class?: string;
				children?: Snippet;
		  } & Omit<HTMLAnchorAttributes, 'class' | 'children'>)
		| ({
				href?: undefined;
				variant?: ButtonVariant;
				size?: ButtonSize;
				class?: string;
				children?: Snippet;
		  } & Omit<HTMLButtonAttributes, 'class' | 'children'>);

	let { class: className = '', variant, size, href, children, ...rest }: Props = $props();
</script>

{#if href}
	<a
		{href}
		class={cn(buttonVariants({ variant, size }), className)}
		{...rest as HTMLAnchorAttributes}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		class={cn(buttonVariants({ variant, size }), className)}
		{...rest as HTMLButtonAttributes}
	>
		{@render children?.()}
	</button>
{/if}
