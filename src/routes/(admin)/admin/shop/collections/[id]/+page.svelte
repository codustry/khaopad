<script lang="ts">
	/**
	 * Collection editor.
	 *
	 * Follows the product editor's idioms deliberately: one `?/save`
	 * form, DirtyState-driven SaveBar wired by `formId` so ⌘S works, and
	 * a navigate-away guard. The membership picker submits the complete
	 * desired set of product ids, which the server replaces wholesale.
	 */
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Boxes, Trash2 } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		DataTable,
		StatusBadge,
		SaveBar,
		DirtyState,
		guardUnsavedChanges,
		type Column
	} from '$lib/components/admin';
	import * as m from '$lib/paraglide/messages';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const collection = $derived(data.collection);

	// Seeded once from the loaded collection — re-seeding on prop
	// changes would clobber in-progress edits (same note as the product
	// editor / ArticleForm).
	const initialValues = () => ({
		titleEn: data.localizations['en']?.title ?? '',
		descEn: data.localizations['en']?.descriptionMarkdown ?? '',
		titleTh: data.localizations['th']?.title ?? '',
		descTh: data.localizations['th']?.descriptionMarkdown ?? '',
		slug: data.collection.slug,
		status: data.collection.status as string,
		memberIds: [...data.memberIds]
	});
	const seed = initialValues();

	let titleEn = $state(seed.titleEn);
	let descEn = $state(seed.descEn);
	let titleTh = $state(seed.titleTh);
	let descTh = $state(seed.descTh);
	let slug = $state(seed.slug);
	let status = $state(seed.status);
	let memberIds = $state(seed.memberIds);
	let saving = $state(false);

	const isMember = (id: string) => memberIds.includes(id);
	function toggleMember(id: string, on: boolean) {
		memberIds = on ? [...memberIds, id] : memberIds.filter((m) => m !== id);
	}

	const snapshot = () =>
		JSON.stringify([titleEn, descEn, titleTh, descTh, slug, status, [...memberIds].sort()]);
	const dirty = new DirtyState(snapshot());
	$effect(() => dirty.update(snapshot()));
	guardUnsavedChanges(() => dirty.dirty, m.admin_leave_confirm());

	function discard() {
		const fresh = initialValues();
		titleEn = fresh.titleEn;
		descEn = fresh.descEn;
		titleTh = fresh.titleTh;
		descTh = fresh.descTh;
		slug = fresh.slug;
		status = fresh.status;
		memberIds = fresh.memberIds;
		dirty.reset(snapshot());
	}

	type Member = PageData['products'][number];

	const memberColumns: Column<Member>[] = [
		{ key: 'title', header: m.shop_admin_col_title(), cell: memberTitleCell },
		{ key: 'remove', header: '', align: 'right', cell: removeCell }
	];
</script>

{#snippet memberTitleCell(p: Member)}
	<a
		href={resolve('/(admin)/admin/shop/products/[id]', { id: p.id })}
		class="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
	>
		{p.title}
	</a>
{/snippet}

{#snippet removeCell(p: Member)}
	<Button
		type="button"
		variant="outline"
		size="sm"
		disabled={!isMember(p.id)}
		onclick={() => toggleMember(p.id, false)}
	>
		Remove
	</Button>
{/snippet}

<svelte:head>
	<title>{titleEn || collection.slug} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="wide">
	<PageHeader
		title={titleEn || collection.slug}
		description="/collections/{collection.slug}"
		icon={Boxes}
		breadcrumbs={[
			{ label: m.shop_admin_collections(), href: resolve('/(admin)/admin/shop/collections') },
			{ label: titleEn || collection.slug }
		]}
	>
		{#snippet actions()}
			<StatusBadge status={collection.status} />
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div
				class="rounded-md border border-red-300 bg-red-100 p-3 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300"
			>
				{form.error}
			</div>
		{:else if form?.success}
			<div
				class="rounded-md border border-green-300 bg-green-100 p-3 text-sm text-green-800 dark:border-green-500/40 dark:bg-green-500/15 dark:text-green-300"
			>
				{form.message}
			</div>
		{/if}

		<form
			id="collection-save-form"
			method="POST"
			action="?/save"
			class="space-y-6"
			use:enhance={() => {
				saving = true;
				dirty.beginSave();
				return async ({ update, result }) => {
					await update({ reset: false });
					saving = false;
					if (result.type === 'success') {
						dirty.commit(snapshot());
					} else {
						dirty.abortSave();
					}
				};
			}}
		>
			<div class="grid gap-6 lg:grid-cols-2">
				<section class="space-y-4 rounded-lg border border-border p-4">
					<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
						{m.shop_admin_en_section()}
					</h2>
					<div class="space-y-2">
						<Label for="title_en">{m.shop_admin_title()}</Label>
						<Input
							id="title_en"
							name="title_en"
							required
							maxlength={200}
							bind:value={titleEn}
							disabled={saving}
						/>
						<p class="text-xs text-muted-foreground">{m.shop_admin_title_en_help()}</p>
					</div>
					<div class="space-y-2">
						<Label for="description_en">{m.shop_admin_description()}</Label>
						<textarea
							id="description_en"
							name="description_en"
							rows="5"
							bind:value={descEn}
							class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
							disabled={saving}
						></textarea>
					</div>
				</section>

				<section class="space-y-4 rounded-lg border border-border p-4">
					<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
						{m.shop_admin_th_section()}
					</h2>
					<div class="space-y-2">
						<Label for="title_th">{m.shop_admin_title()}</Label>
						<Input
							id="title_th"
							name="title_th"
							maxlength={200}
							bind:value={titleTh}
							disabled={saving}
						/>
					</div>
					<div class="space-y-2">
						<Label for="description_th">{m.shop_admin_description()}</Label>
						<textarea
							id="description_th"
							name="description_th"
							rows="5"
							bind:value={descTh}
							class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
							disabled={saving}
						></textarea>
					</div>
				</section>
			</div>

			<section class="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
				<div class="space-y-2">
					<Label for="slug">{m.shop_admin_slug()}</Label>
					<Input
						id="slug"
						name="slug"
						bind:value={slug}
						class="font-mono"
						disabled={saving}
					/>
					<p class="text-xs text-muted-foreground">
						Shared across locales and normalized to English-only ASCII.
					</p>
				</div>
				<div class="space-y-2">
					<Label for="status">{m.cms_filter_status()}</Label>
					<select
						id="status"
						name="status"
						bind:value={status}
						disabled={saving}
						class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<option value="draft">{m.status_draft()}</option>
						<option value="active">{m.shop_admin_status_active()}</option>
						<option value="archived">{m.status_archived()}</option>
					</select>
				</div>
			</section>

			<!--
				Membership. The checkboxes carry the form state; the hidden
				inputs are what actually submits, so a product that is a member
				but outside the loaded picker page is never silently dropped.
			-->
			<section class="space-y-3 rounded-lg border border-border p-4">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					{m.shop_admin_col_products()} ({memberIds.length})
				</h2>
				{#each memberIds as id (id)}
					<input type="hidden" name="productIds" value={id} />
				{/each}
				{#if data.allProducts.length > 0}
					<div class="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-2">
						{#each data.allProducts as p (p.id)}
							<label class="flex items-center gap-2 rounded-sm px-1 py-0.5 text-sm hover:bg-muted">
								<input
									type="checkbox"
									checked={isMember(p.id)}
									disabled={saving}
									onchange={(e) => toggleMember(p.id, e.currentTarget.checked)}
								/>
								<span>{p.title}</span>
								{#if p.status !== 'active'}
									<StatusBadge status={p.status} class="ml-auto" />
								{/if}
							</label>
						{/each}
					</div>
				{:else}
					<p class="text-xs text-muted-foreground">
						{m.shop_admin_no_products_for_collection()}
					</p>
				{/if}
			</section>
		</form>

		<!-- Saved membership, as links out to each product editor. -->
		<section class="space-y-3">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				In this collection
			</h2>
			<DataTable columns={memberColumns} rows={data.products} getKey={(p) => p.id}>
				{#snippet empty()}
					<p class="text-sm text-muted-foreground">
						No products yet — tick some above and save.
					</p>
				{/snippet}
			</DataTable>
		</section>

		<section class="rounded-lg border border-destructive/40 p-4">
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-sm font-medium">Delete collection</p>
					<p class="text-xs text-muted-foreground">
						Removes the collection and its product assignments. The products themselves are
						untouched.
					</p>
				</div>
				<form
					method="POST"
					action="?/delete"
					use:enhance={({ cancel }) => {
						if (!confirm(`Delete “${titleEn || collection.slug}”?`)) cancel();
					}}
				>
					<Button type="submit" variant="destructive" size="sm">
						<Trash2 class="mr-2 h-4 w-4" />
						{m.shop_admin_delete()}
					</Button>
				</form>
			</div>
		</section>

		<!-- Sits outside the form, so the submit button targets it by id
		     (the ⌘S hook lives on that button). -->
		<SaveBar dirty={dirty.dirty} {saving} onDiscard={discard} formId="collection-save-form" />
	</div>
</PageShell>
