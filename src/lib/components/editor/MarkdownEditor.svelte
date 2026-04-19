<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { marked } from 'marked';
	import MediaPicker from './MediaPicker.svelte';
	import type { MediaRecord } from '$lib/server/media/types';

	let {
		value = $bindable(''),
		name,
		rows = 14,
		required = false,
		placeholder = '',
		/**
		 * Per-field draft key. When set, the editor autosaves to
		 * localStorage[`khaopad:draft:${draftKey}`] and offers recovery on
		 * re-open. Pass `null` to disable (e.g. for ephemeral forms).
		 */
		draftKey = null as string | null,
	}: {
		value?: string;
		name: string;
		rows?: number;
		required?: boolean;
		placeholder?: string;
		draftKey?: string | null;
	} = $props();

	type Mode = 'write' | 'split' | 'preview';
	let mode = $state<Mode>('split');
	let pickerOpen = $state(false);
	let textarea = $state<HTMLTextAreaElement | null>(null);

	// ─── Preview ─────────────────────────────────────────
	// marked is safe to call on trusted author input. We run it client-side
	// so the preview pane stays in sync with every keystroke — no network.
	const rendered = $derived.by(() => {
		try {
			return marked.parse(value ?? '', { async: false }) as string;
		} catch {
			return '';
		}
	});

	// ─── Autosave & recovery ─────────────────────────────
	// Strategy: debounced write to localStorage on every change. On mount,
	// if a draft exists AND is newer + different from the seeded value, show
	// a "restore?" banner. Cleared on successful form submit by the parent.
	const storageKey = $derived(draftKey ? `khaopad:draft:${draftKey}` : null);
	let draftAvailable = $state<null | { value: string; savedAt: string }>(null);
	let initialValue = $state(value); // capture seed so we know what to compare against

	$effect(() => {
		if (typeof window === 'undefined') return;
		if (!storageKey) return;
		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) return;
			const parsed = JSON.parse(raw) as { value: string; savedAt: string };
			if (parsed.value && parsed.value !== initialValue) {
				draftAvailable = parsed;
			}
		} catch {
			// corrupt draft → ignore
		}
	});

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (typeof window === 'undefined') return;
		if (!storageKey) return;
		// Skip the very first effect run (value === initialValue).
		if (value === initialValue) return;
		if (saveTimer) clearTimeout(saveTimer);
		const snapshot = value;
		saveTimer = setTimeout(() => {
			try {
				localStorage.setItem(
					storageKey,
					JSON.stringify({ value: snapshot, savedAt: new Date().toISOString() }),
				);
			} catch {
				// quota / private mode → silently give up; user work isn't blocked
			}
		}, 600);
	});

	function restoreDraft() {
		if (!draftAvailable) return;
		value = draftAvailable.value;
		draftAvailable = null;
	}

	function discardDraft() {
		if (storageKey) {
			try {
				localStorage.removeItem(storageKey);
			} catch {
				// ignore
			}
		}
		draftAvailable = null;
	}

	// ─── Text manipulation helpers ───────────────────────
	function surround(before: string, after = before, placeholder = '') {
		const ta = textarea;
		if (!ta) return;
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		const selected = value.slice(start, end) || placeholder;
		const next = value.slice(0, start) + before + selected + after + value.slice(end);
		value = next;
		// Restore selection inside the inserted region on the next tick.
		queueMicrotask(() => {
			ta.focus();
			const cursorStart = start + before.length;
			const cursorEnd = cursorStart + selected.length;
			ta.setSelectionRange(cursorStart, cursorEnd);
		});
	}

	function prefixLine(prefix: string) {
		const ta = textarea;
		if (!ta) return;
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		// Expand selection to include whole lines.
		const lineStart = value.lastIndexOf('\n', start - 1) + 1;
		const lineEnd = value.indexOf('\n', end);
		const sliceEnd = lineEnd === -1 ? value.length : lineEnd;
		const block = value.slice(lineStart, sliceEnd);
		const prefixed = block
			.split('\n')
			.map((line) => (line.startsWith(prefix) ? line : prefix + line))
			.join('\n');
		value = value.slice(0, lineStart) + prefixed + value.slice(sliceEnd);
		queueMicrotask(() => {
			ta.focus();
			ta.setSelectionRange(lineStart, lineStart + prefixed.length);
		});
	}

	function insertAtCursor(text: string) {
		const ta = textarea;
		if (!ta) {
			value = (value ?? '') + text;
			return;
		}
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		value = value.slice(0, start) + text + value.slice(end);
		queueMicrotask(() => {
			ta.focus();
			const cursor = start + text.length;
			ta.setSelectionRange(cursor, cursor);
		});
	}

	function onMediaPicked(media: MediaRecord) {
		const alt = media.altText || media.filename;
		const url = `/api/media/${media.id}`;
		if (media.mimeType.startsWith('image/')) {
			insertAtCursor(`![${alt}](${url})`);
		} else {
			insertAtCursor(`[${alt}](${url})`);
		}
	}

	// ─── Keyboard shortcuts ──────────────────────────────
	function onKeydown(e: KeyboardEvent) {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;
		switch (e.key.toLowerCase()) {
			case 'b':
				e.preventDefault();
				surround('**', '**', m.cms_editor_ph_bold());
				break;
			case 'i':
				e.preventDefault();
				surround('*', '*', m.cms_editor_ph_italic());
				break;
			case 'k':
				e.preventDefault();
				surround('[', '](https://)', m.cms_editor_ph_link());
				break;
		}
	}

	// Public helper: the parent form should clear the draft once a save
	// action succeeds. Exported via component binding.
	export function clearDraft() {
		discardDraft();
	}
</script>

<div class="border border-input rounded-md bg-background overflow-hidden">
	{#if draftAvailable}
		<div
			class="flex items-center justify-between gap-3 flex-wrap px-3 py-2 border-b border-border bg-amber-50 dark:bg-amber-950/30 text-sm"
		>
			<span>
				{m.cms_editor_draft_available({
					when: new Date(draftAvailable.savedAt).toLocaleString(),
				})}
			</span>
			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={restoreDraft}
					class="px-2 py-1 bg-primary text-primary-foreground rounded text-xs hover:opacity-90"
				>
					{m.cms_editor_draft_restore()}
				</button>
				<button
					type="button"
					onclick={discardDraft}
					class="px-2 py-1 border border-border rounded text-xs hover:bg-muted"
				>
					{m.cms_editor_draft_discard()}
				</button>
			</div>
		</div>
	{/if}

	<!-- Toolbar -->
	<div
		class="flex items-center justify-between gap-2 flex-wrap px-2 py-1.5 border-b border-border bg-muted/30"
	>
		<div class="flex items-center gap-0.5 flex-wrap">
			<button
				type="button"
				onclick={() => surround('**', '**', m.cms_editor_ph_bold())}
				title="{m.cms_editor_btn_bold()} (⌘B)"
				class="px-2 py-1 rounded hover:bg-muted text-sm font-bold"
			>
				B
			</button>
			<button
				type="button"
				onclick={() => surround('*', '*', m.cms_editor_ph_italic())}
				title="{m.cms_editor_btn_italic()} (⌘I)"
				class="px-2 py-1 rounded hover:bg-muted text-sm italic"
			>
				I
			</button>
			<span class="mx-1 h-5 w-px bg-border"></span>
			<button
				type="button"
				onclick={() => prefixLine('# ')}
				title={m.cms_editor_btn_h1()}
				class="px-2 py-1 rounded hover:bg-muted text-sm"
			>
				H1
			</button>
			<button
				type="button"
				onclick={() => prefixLine('## ')}
				title={m.cms_editor_btn_h2()}
				class="px-2 py-1 rounded hover:bg-muted text-sm"
			>
				H2
			</button>
			<span class="mx-1 h-5 w-px bg-border"></span>
			<button
				type="button"
				onclick={() => surround('[', '](https://)', m.cms_editor_ph_link())}
				title="{m.cms_editor_btn_link()} (⌘K)"
				class="px-2 py-1 rounded hover:bg-muted text-sm"
				aria-label={m.cms_editor_btn_link()}
			>
				🔗
			</button>
			<button
				type="button"
				onclick={() => (pickerOpen = true)}
				title={m.cms_editor_btn_image()}
				class="px-2 py-1 rounded hover:bg-muted text-sm"
				aria-label={m.cms_editor_btn_image()}
			>
				🖼
			</button>
			<span class="mx-1 h-5 w-px bg-border"></span>
			<button
				type="button"
				onclick={() => prefixLine('- ')}
				title={m.cms_editor_btn_ul()}
				class="px-2 py-1 rounded hover:bg-muted text-sm"
			>
				• list
			</button>
			<button
				type="button"
				onclick={() => prefixLine('1. ')}
				title={m.cms_editor_btn_ol()}
				class="px-2 py-1 rounded hover:bg-muted text-sm"
			>
				1. list
			</button>
			<button
				type="button"
				onclick={() => surround('`', '`', 'code')}
				title={m.cms_editor_btn_code()}
				class="px-2 py-1 rounded hover:bg-muted text-sm font-mono"
			>
				&lt;/&gt;
			</button>
			<button
				type="button"
				onclick={() => prefixLine('> ')}
				title={m.cms_editor_btn_quote()}
				class="px-2 py-1 rounded hover:bg-muted text-sm"
			>
				“ ”
			</button>
		</div>

		<!-- Mode toggle -->
		<div class="flex items-center rounded-md border border-border overflow-hidden text-xs">
			<button
				type="button"
				onclick={() => (mode = 'write')}
				class="px-2 py-1 {mode === 'write' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}"
			>
				{m.cms_editor_mode_write()}
			</button>
			<button
				type="button"
				onclick={() => (mode = 'split')}
				class="px-2 py-1 border-x border-border {mode === 'split'
					? 'bg-primary text-primary-foreground'
					: 'hover:bg-muted'}"
			>
				{m.cms_editor_mode_split()}
			</button>
			<button
				type="button"
				onclick={() => (mode = 'preview')}
				class="px-2 py-1 {mode === 'preview'
					? 'bg-primary text-primary-foreground'
					: 'hover:bg-muted'}"
			>
				{m.cms_editor_mode_preview()}
			</button>
		</div>
	</div>

	<!-- Panes -->
	<div class="grid {mode === 'split' ? 'md:grid-cols-2' : 'grid-cols-1'}">
		{#if mode !== 'preview'}
			<textarea
				bind:this={textarea}
				bind:value
				{name}
				{required}
				{rows}
				{placeholder}
				onkeydown={onKeydown}
				class="w-full px-3 py-2 bg-background text-sm font-mono resize-y focus:outline-none
					{mode === 'split' ? 'border-r border-border' : ''}"
			></textarea>
		{/if}

		{#if mode !== 'write'}
			<div
				class="prose prose-sm max-w-none px-3 py-2 overflow-auto bg-muted/10"
				style="min-height: {rows * 1.5}rem;"
			>
				{#if (value ?? '').trim().length === 0}
					<p class="text-muted-foreground italic text-sm m-0">
						{m.cms_editor_preview_empty()}
					</p>
				{:else}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html rendered}
				{/if}
			</div>
		{/if}
	</div>
</div>

<MediaPicker bind:open={pickerOpen} onSelect={onMediaPicked} />
