<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import type { MediaRecord } from '$lib/server/media/types';

	let {
		open = $bindable(false),
		onSelect,
	}: {
		open?: boolean;
		onSelect: (media: MediaRecord) => void;
	} = $props();

	let items = $state<MediaRecord[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/media', { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { items: MediaRecord[] };
			items = data.items;
			loaded = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load media';
		} finally {
			loading = false;
		}
	}

	// Lazy-load on first open so the initial article-edit render isn't blocked.
	$effect(() => {
		if (open && !loaded && !loading) {
			load();
		}
	});

	function close() {
		open = false;
	}

	function pick(media: MediaRecord) {
		onSelect(media);
		close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={close}
		role="presentation"
	>
		<div
			class="bg-background border border-border rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-label={m.cms_editor_media_picker_title()}
		>
			<header class="flex items-center justify-between p-4 border-b border-border">
				<h2 class="font-semibold">{m.cms_editor_media_picker_title()}</h2>
				<button
					type="button"
					onclick={close}
					class="text-muted-foreground hover:text-foreground text-sm"
					aria-label={m.cms_cancel()}
				>
					✕
				</button>
			</header>

			<div class="flex-1 overflow-y-auto p-4">
				{#if loading}
					<p class="text-sm text-muted-foreground">{m.cms_editor_media_picker_loading()}</p>
				{:else if error}
					<p class="text-sm text-destructive">{error}</p>
				{:else if items.length === 0}
					<p class="text-sm text-muted-foreground">{m.cms_media_empty()}</p>
				{:else}
					<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
						{#each items as media (media.id)}
							<button
								type="button"
								onclick={() => pick(media)}
								class="group relative border border-border rounded-md overflow-hidden aspect-square hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
								title={media.filename}
							>
								{#if media.mimeType.startsWith('image/')}
									<img
										src={`/api/media/${media.id}`}
										alt={media.altText ?? media.filename}
										class="w-full h-full object-cover"
										loading="lazy"
									/>
								{:else}
									<div
										class="w-full h-full flex flex-col items-center justify-center bg-muted text-muted-foreground p-2 text-center"
									>
										<span class="text-xs font-mono truncate w-full">{media.filename}</span>
										<span class="text-[10px] mt-1">{media.mimeType}</span>
									</div>
								{/if}
								<span
									class="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate opacity-0 group-hover:opacity-100"
								>
									{media.filename}
								</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
