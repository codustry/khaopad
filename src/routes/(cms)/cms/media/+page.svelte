<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import type { MediaFolderRecord, MediaRecord } from '$lib/server/media/types';

	let {
		data,
	}: {
		data: {
			items: MediaRecord[];
			folders: MediaFolderRecord[];
			activeFolderId: string | null;
			isFiltered: boolean;
			user?: { role: string };
		};
	} = $props();

	let uploading = $state(false);
	let uploadError = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let altText = $state('');

	let creatingFolder = $state(false);
	let newFolderName = $state('');

	let renamingId = $state<string | null>(null);
	let renameValue = $state('');

	const activeFolderId = $derived(data.activeFolderId);
	const isFiltered = $derived(data.isFiltered);
	const canManage = $derived(
		Boolean(data.user && ['super_admin', 'admin', 'editor'].includes(data.user.role)),
	);

	// Build a parent → children map for the folder tree. Local to the
	// derived; never read reactively (rebuilt every invocation), so a
	// plain Map is correct — no need for SvelteMap's reactivity overhead.
	const childrenByParent = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup, not reactive state
		const map = new Map<string | null, MediaFolderRecord[]>();
		for (const f of data.folders) {
			const parent = f.parentId ?? null;
			if (!map.has(parent)) map.set(parent, []);
			map.get(parent)!.push(f);
		}
		for (const arr of map.values()) {
			arr.sort((a, b) => a.name.localeCompare(b.name));
		}
		return map;
	});
	const folderById = $derived(new Map(data.folders.map((f) => [f.id, f])));

	function folderHref(folderId: string | null | 'all'): string {
		if (folderId === 'all') return '/cms/media';
		if (folderId === null) return '/cms/media?folder=root';
		return `/cms/media?folder=${folderId}`;
	}

	async function onUpload(event: SubmitEvent) {
		event.preventDefault();
		if (!fileInput?.files || fileInput.files.length === 0) return;

		uploadError = null;
		uploading = true;
		try {
			const body = new FormData();
			body.append('file', fileInput.files[0]);
			if (altText.trim()) body.append('altText', altText.trim());
			// When uploading from inside a specific folder view, drop new
			// uploads into that folder. From "All" or root view, root.
			if (activeFolderId) body.append('folderId', activeFolderId);

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

	function startRename(folder: MediaFolderRecord) {
		renamingId = folder.id;
		renameValue = folder.name;
	}

	async function moveMedia(mediaId: string, folderId: string | null) {
		const body = new FormData();
		body.append('id', mediaId);
		body.append('folder_id', folderId ?? '');
		const res = await fetch(`${page.url.pathname}?/moveMedia`, {
			method: 'POST',
			body,
		});
		if (res.ok) await invalidateAll();
	}

	// Drag-drop wiring: each tile is draggable; each folder row is a drop target.
	function onDragStart(e: DragEvent, mediaId: string) {
		if (!canManage || !e.dataTransfer) return;
		e.dataTransfer.setData('application/x-media-id', mediaId);
		e.dataTransfer.effectAllowed = 'move';
	}
	function onDragOver(e: DragEvent) {
		if (!canManage) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}
	function onDrop(e: DragEvent, folderId: string | null) {
		if (!canManage) return;
		e.preventDefault();
		const id = e.dataTransfer?.getData('application/x-media-id');
		if (id) void moveMedia(id, folderId);
	}
</script>

<svelte:head>
	<title>{m.cms_media()} — {m.cms_app_name()}</title>
</svelte:head>

<div class="space-y-6">
	<header class="flex items-center justify-between flex-wrap gap-3">
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
		{#if activeFolderId}
			{@const f = folderById.get(activeFolderId)}
			{#if f}
				<p class="text-xs text-muted-foreground">
					{m.cms_media_upload_target({ folder: f.name })}
				</p>
			{/if}
		{/if}
		{#if uploadError}
			<p class="text-sm text-destructive">{uploadError}</p>
		{/if}
	</form>

	<div class="grid lg:grid-cols-[220px_1fr] gap-6">
		<!-- Folder tree sidebar -->
		<aside class="space-y-2">
			<div class="flex items-center justify-between">
				<h2 class="text-sm font-semibold">{m.cms_media_folders()}</h2>
				{#if canManage}
					<button
						type="button"
						onclick={() => (creatingFolder = !creatingFolder)}
						class="text-xs px-2 py-1 border border-border rounded-md hover:bg-muted"
					>
						{creatingFolder ? m.cms_cancel() : m.cms_media_folder_new()}
					</button>
				{/if}
			</div>

			{#if creatingFolder}
				<form
					method="POST"
					action="?/createFolder"
					use:enhance={() =>
						async ({ update, result }) => {
							await update();
							if (result.type === 'success') {
								creatingFolder = false;
								newFolderName = '';
							}
						}}
					class="space-y-1.5 border border-border rounded-md p-2 bg-muted/30"
				>
					<input
						name="name"
						bind:value={newFolderName}
						placeholder={m.cms_media_folder_name_placeholder()}
						required
						class="w-full px-2 py-1.5 border border-input rounded-md bg-background text-xs"
					/>
					{#if activeFolderId}
						<input type="hidden" name="parent_id" value={activeFolderId} />
						<p class="text-[10px] text-muted-foreground">
							{m.cms_media_folder_will_nest({
								parent: folderById.get(activeFolderId)?.name ?? '',
							})}
						</p>
					{/if}
					<button
						type="submit"
						class="w-full px-2 py-1.5 bg-primary text-primary-foreground rounded-md text-xs hover:opacity-90"
					>
						{m.cms_media_folder_create()}
					</button>
				</form>
			{/if}

			<ul class="space-y-0.5">
				<li>
					<a
						href={folderHref('all')}
						ondragover={onDragOver}
						ondrop={(e) => onDrop(e, null)}
						class="flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-muted {!isFiltered ? 'bg-muted font-medium' : ''}"
					>
						<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
							><circle cx="12" cy="12" r="9" /></svg
						>
						{m.cms_media_folder_all()}
					</a>
				</li>
				<li>
					<a
						href={folderHref(null)}
						ondragover={onDragOver}
						ondrop={(e) => onDrop(e, null)}
						class="flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-muted {isFiltered && activeFolderId === null ? 'bg-muted font-medium' : ''}"
					>
						<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
							><path d="M3 7l4-4h4l2 2h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" /></svg
						>
						{m.cms_media_folder_root()}
					</a>
				</li>
				{#snippet folderRow(folder: MediaFolderRecord, depth: number)}
					<li>
						<div
							class="flex items-center gap-1 px-2 py-1.5 text-sm rounded-md hover:bg-muted {activeFolderId === folder.id ? 'bg-muted font-medium' : ''}"
							style="padding-left: {depth * 12 + 8}px;"
							ondragover={onDragOver}
							ondrop={(e) => onDrop(e, folder.id)}
							role="treeitem"
							aria-selected={activeFolderId === folder.id}
						>
							{#if renamingId === folder.id}
								<form
									method="POST"
									action="?/renameFolder"
									use:enhance={() =>
										async ({ update, result }) => {
											await update();
											if (result.type === 'success') renamingId = null;
										}}
									class="flex-1 flex items-center gap-1"
								>
									<input type="hidden" name="id" value={folder.id} />
									<input
										name="name"
										bind:value={renameValue}
										required
										class="flex-1 px-1.5 py-0.5 border border-input rounded text-xs bg-background"
									/>
									<button type="submit" class="text-xs text-primary hover:underline">{m.cms_save()}</button>
								</form>
							{:else}
								<a href={folderHref(folder.id)} class="flex-1 flex items-center gap-2 truncate">
									<svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
										><path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg
									>
									<span class="truncate">{folder.name}</span>
								</a>
								{#if canManage}
									<button
										type="button"
										onclick={() => startRename(folder)}
										title={m.cms_media_folder_rename()}
										class="opacity-0 hover:opacity-100 text-muted-foreground hover:text-foreground"
									>
										<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
											><path d="M15 5l4 4L8 20H4v-4z" /></svg
										>
									</button>
									<form
										method="POST"
										action="?/deleteFolder"
										use:enhance={({ cancel }) => {
											if (!confirm(m.cms_media_folder_delete_confirm())) {
												cancel();
												return;
											}
											return async ({ update }) => update();
										}}
									>
										<input type="hidden" name="id" value={folder.id} />
										<button
											type="submit"
											title={m.cms_delete()}
											class="text-muted-foreground hover:text-destructive"
										>
											<svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
												><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg
											>
										</button>
									</form>
								{/if}
							{/if}
						</div>
						{#if childrenByParent.has(folder.id)}
							{#each childrenByParent.get(folder.id) ?? [] as child (child.id)}
								{@render folderRow(child, depth + 1)}
							{/each}
						{/if}
					</li>
				{/snippet}
				{#each childrenByParent.get(null) ?? [] as folder (folder.id)}
					{@render folderRow(folder, 0)}
				{/each}
			</ul>
		</aside>

		<!-- Media grid -->
		<div>
			{#if data.items.length === 0}
				<p class="text-sm text-muted-foreground">{m.cms_media_empty()}</p>
			{:else}
				<ul class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
					{#each data.items as item (item.id)}
						<li
							class="border border-border rounded-lg overflow-hidden bg-card cursor-grab active:cursor-grabbing"
							draggable={canManage}
							ondragstart={(e) => onDragStart(e, item.id)}
						>
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
											use:enhance={() =>
												async ({ update }) => {
													await update();
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
	</div>
</div>

