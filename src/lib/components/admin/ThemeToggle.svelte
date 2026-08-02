<script lang="ts">
	/**
	 * Light / dark / system toggle.
	 *
	 * Cycles rather than opening a menu: three states is few enough that
	 * a menu costs more clicks than it saves, and the icon plus its
	 * tooltip make the current state legible without opening anything.
	 *
	 * `aria-live="polite"` on the label matters here — the visible change
	 * is purely colour, which a screen-reader user cannot perceive, so
	 * the state change has to be announced.
	 */
	import { Monitor, Moon, Sun } from 'lucide-svelte';
	import { theme } from './theme.svelte';
	import * as m from '$lib/paraglide/messages';

	const label = $derived(
		theme.preference === 'light'
			? m.admin_theme_light()
			: theme.preference === 'dark'
				? m.admin_theme_dark()
				: m.admin_theme_system()
	);
</script>

<button
	type="button"
	onclick={() => theme.cycle()}
	title={label}
	aria-label="{m.admin_theme_toggle()}: {label}"
	class="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
>
	{#if theme.preference === 'light'}
		<Sun class="h-4 w-4" aria-hidden="true" />
	{:else if theme.preference === 'dark'}
		<Moon class="h-4 w-4" aria-hidden="true" />
	{:else}
		<Monitor class="h-4 w-4" aria-hidden="true" />
	{/if}
	<span class="sr-only" aria-live="polite">{label}</span>
</button>
