<script lang="ts">
	/**
	 * Sticky save bar, shown once the form is dirty.
	 *
	 * ## The problem this solves
	 *
	 * On the article editor the page is 6050px tall, "Save draft" sat at
	 * 5860px, and the viewport is 900px — so saving an edit meant
	 * scrolling past the entire markdown body. Nothing was sticky. This
	 * was the single highest-friction interaction in the product, and it
	 * is the same thing Polaris's ContextualSaveBar and Stripe's sticky
	 * footer exist to solve.
	 *
	 * ## Why it only appears when dirty
	 *
	 * A permanently-visible bar costs ~64px of vertical space on every
	 * page for an action that is irrelevant most of the time. Appearing on
	 * the first edit also doubles as feedback that a change was
	 * registered — useful in an editor where most keystrokes produce no
	 * other visible state change.
	 *
	 * `role="status"` rather than `role="alert"`: this is informational,
	 * and `alert` interrupts a screen reader mid-sentence, which is
	 * actively hostile while someone is typing.
	 */
	import { cn } from '$lib/utils';
	import { Button } from '$lib/components/ui';
	import * as m from '$lib/paraglide/messages';
	import type { Snippet } from 'svelte';

	let {
		dirty,
		saving = false,
		onSave,
		onDiscard,
		saveLabel,
		message,
		extra,
		formId,
		class: className = ''
	}: {
		dirty: boolean;
		saving?: boolean;
		/** Omit when the bar sits inside a <form> and the button submits it. */
		onSave?: () => void;
		onDiscard?: () => void;
		saveLabel?: string;
		/** Overrides the default "Unsaved changes" text. */
		message?: string;
		/** Extra controls, rendered left of Discard (e.g. a status select). */
		extra?: Snippet;
		/**
		 * Associates the submit button with a form by id, for bars that
		 * sit OUTSIDE their form element (e.g. the product editor, where
		 * per-row inventory forms make containment impossible).
		 */
		formId?: string;
		class?: string;
	} = $props();
</script>

{#if dirty}
	<!--
		`sticky bottom-0` inside the page's own scroll container rather than
		`fixed`: fixed positioning would sit above the mobile sidebar
		overlay and, on iOS, fight the dynamic URL bar for the same pixels.

		`pb-[env(safe-area-inset-bottom)]` keeps the buttons clear of the
		home indicator on notched iPhones, where a bottom-anchored control
		is otherwise partly untappable.
	-->
	<div
		role="status"
		aria-live="polite"
		class={cn(
			'sticky bottom-0 z-30 -mx-4 mt-6 border-t border-border bg-card/95 px-4 py-3 shadow-[0_-1px_3px_rgba(0,0,0,0.06)] backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:-mx-6 sm:px-6',
			'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
			className
		)}
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<p class="text-sm text-muted-foreground">
				{message ?? m.admin_unsaved_changes()}
			</p>
			<div class="flex flex-wrap items-center gap-2">
				{#if extra}{@render extra()}{/if}
				{#if onDiscard}
					<Button type="button" variant="outline" onclick={onDiscard} disabled={saving}>
						{m.admin_discard()}
					</Button>
				{/if}
				<!--
					`data-savebar-submit` is the ⌘S hook: the admin layout's
					global shortcut queries for this attribute and clicks it.
					Since the bar only renders while dirty, "no button found"
					is exactly the "nothing to save" state — no event bus or
					per-page subscription needed.
				-->
				{#if onSave}
					<Button type="button" data-savebar-submit onclick={onSave} disabled={saving}>
						{saving ? m.admin_saving() : (saveLabel ?? m.admin_save())}
					</Button>
				{:else}
					<Button type="submit" data-savebar-submit form={formId} disabled={saving}>
						{saving ? m.admin_saving() : (saveLabel ?? m.admin_save())}
					</Button>
				{/if}
			</div>
		</div>
	</div>
{/if}
