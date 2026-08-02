<script lang="ts" module>
	/**
	 * Status pill for content and commerce states.
	 *
	 * ## Why not just use `<Badge>`
	 *
	 * `<Badge>`'s variants are visual (default / secondary / destructive).
	 * Statuses are semantic, and pages were translating them by hand with
	 * literals like `bg-green-100 text-green-800`. Two problems with that:
	 * the same status got different colours on different pages, and those
	 * literals are light-mode-only — `green-100` stays a pale wash on a
	 * dark background, where the `green-800` text on it is unreadable.
	 *
	 * So every colour here is declared as a light/dark pair. A status
	 * badge is one of the few places where a wrong colour is a
	 * correctness bug rather than a taste issue: "published" reading as
	 * "draft" is a factual error about the state of someone's content.
	 *
	 * ## Colour choices
	 *
	 * Deliberately not red/green alone — roughly 1 in 12 men has a
	 * red-green colour deficiency, so the label text carries the meaning
	 * and colour only reinforces it. That is also why this renders text
	 * rather than a bare dot.
	 */
	export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

	const TONES: Record<StatusTone, string> = {
		success:
			'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300 ring-green-600/20 dark:ring-green-400/25',
		warning:
			'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 ring-amber-600/20 dark:ring-amber-400/25',
		danger:
			'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300 ring-red-600/20 dark:ring-red-400/25',
		info: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300 ring-blue-600/20 dark:ring-blue-400/25',
		neutral:
			'bg-muted text-muted-foreground ring-border'
	};

	/**
	 * Maps the status strings the app actually stores to a tone.
	 *
	 * Unknown values fall through to `neutral` rather than throwing: a
	 * plugin can introduce a status this map has never seen, and a badge
	 * is not worth crashing a page over.
	 */
	const STATUS_TONES: Record<string, StatusTone> = {
		published: 'success',
		active: 'success',
		paid: 'success',
		fulfilled: 'success',
		completed: 'success',
		succeeded: 'success',

		draft: 'warning',
		pending: 'warning',
		scheduled: 'warning',
		processing: 'warning',
		unfulfilled: 'warning',

		failed: 'danger',
		cancelled: 'danger',
		canceled: 'danger',
		refunded: 'danger',
		expired: 'danger',

		archived: 'neutral'
	};

	export function toneForStatus(status: string): StatusTone {
		return STATUS_TONES[status.toLowerCase()] ?? 'neutral';
	}
</script>

<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		status,
		label,
		tone,
		class: className = ''
	}: {
		/** The raw stored status; drives the colour unless `tone` overrides. */
		status: string;
		/** Display text — pass a translated string. Defaults to `status`. */
		label?: string;
		tone?: StatusTone;
		class?: string;
	} = $props();

	const resolvedTone = $derived(tone ?? toneForStatus(status));
</script>

<!--
	`ring` rather than `border` so the pill keeps its exact box size; a
	1px border would shift alignment in a table cell against unbadged
	siblings.
-->
<span
	class={cn(
		'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
		TONES[resolvedTone],
		className
	)}
>
	{label ?? status}
</span>
