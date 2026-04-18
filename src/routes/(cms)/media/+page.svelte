<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';

	let { data } = $props();

	let uploading = $state(false);
	let uploadError = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let altText = $state('');

	async function onUpload(event: SubmitEvent) {
		event.preventDefault();
		if (!fileInput?.files || fileInput.files.length === 0) return;

		uploadError = null;
		uploading = true;
		try {
			const body = new FormData();
			body.append('file', fileInput.files[0]);
			if (altText.trim()) body.append('altText', altText.trim());

			const res = await fetch('/api/media', { method: 'POST', body });
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Upload failed (${res.status}): ${text}`);
			}
			if (fileInput) fileInput.value = '';
			altText = '';
			await invalidateAll();
		} catch (err) {
			uploadError = err instanceof Error ? err.message : String(err);
		} finally {
			uploading = false;
		}
	}

	function isImage(mime: string): boolean {
		return mime.startsWith('image/');
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<div class="space-y-6">
	<header class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold">{m.cms_media()}</h1>
			<p class="text-sm text-muted-foreground">{m.cms_media_help()}</p>
		</div>
	</header>

	<form onsubmit={onUpload} class="border border-border rounded-lg p-4 space-y-3 bg-card">
		<div class="flex flex-col sm:flex-row gap-3 sm:items-end">
			<label class="block flex-1">
				<span class="text-sm font-medium">{m.cms_media_file()}</span>
				<input
					bind:this={fileInput}
					type="file"
					accept="image/*,video/*,audio/*,application/pdf"
					required
					class="mt-1 w-full text-sm"
				/>
			</label>
			<label class="block flex-1">
				<span class="text-sm font-medium">{m.cms_media_alt()}</span>
				<input
					bind:value={altText}
					type="text"
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</label>
			<button
				type="submit"
				disabled={uploading}
				class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50 h-10"
			>
				{uploading ? m.cms_media_uploading() : m.cms_media_upload()}
			</button>
		</div>
		{#if uploadError}
			<p class="text-sm text-destructive">{uploadError}</p>
		{/if}
	</form>

	{#if data.items.length === 0}
		<p class="text-sm text-muted-foreground">{m.cms_media_empty()}</p>
	{:else}
		<ul class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
			{#each data.items as item (item.id)}
				<li class="border border-border rounded-lg overflow-hidden bg-card">
					<div class="aspect-square bg-muted flex items-center justify-center">
						{#if isImage(item.mimeType)}
							<img
								src={`/api/media/${item.id}`}
								alt={item.altText ?? item.filename}
								class="w-full h-full object-cover"
								loading="lazy"
							/>
						{:else}
							<span class="text-xs text-muted-foreground p-2 text-center">{item.mimeType}</span>
						{/if}
					</div>
					<div class="p-2 space-y-1">
						<p class="text-xs font-medium truncate" title={item.filename}>{item.filename}</p>
						<p class="text-[10px] text-muted-foreground">{fmtBytes(item.size)}</p>
						<div class="flex items-center justify-between gap-1">
							<button
								type="button"
								class="text-[10px] text-muted-foreground hover:underline"
								onclick={() => navigator.clipboard.writeText(item.id)}
								title={item.id}
							>
								{m.cms_media_copy_id()}
							</button>
							{#if data.user?.role === 'super_admin' || data.user?.role === 'admin'}
								<form
									method="POST"
									action="?/delete"
									use:enhance={() => {
										return async ({ update }) => {
											await update();
										};
									}}
								>
									<input type="hidden" name="id" value={item.id} />
									<button
										type="submit"
										class="text-[10px] text-destructive hover:underline"
										onclick={(e) => {
											if (!confirm(m.cms_media_delete_confirm())) e.preventDefault();
										}}
									>
										{m.cms_delete()}
									</button>
								</form>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
