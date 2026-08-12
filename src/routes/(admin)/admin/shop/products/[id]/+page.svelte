<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Package, Trash2 } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';
	import { Button, Badge, Input, Label } from '$lib/components/ui';
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
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/** Inverse of parseBahtToSatang: satang → "199.50" for an <input>. */
	function satangToBahtInput(amount: number): string {
		return (amount / 100).toFixed(2);
	}

	const product = $derived(data.product);
	const enTitle = $derived(product.localizations['en']?.title ?? product.slug);

	type Variant = PageData['product']['variants'][number];

	// ── Editable state ──────────────────────────────────────
	// Seeded once from the loaded product (untracked reads on purpose —
	// re-seeding on prop changes would clobber in-progress edits).
	// Same pattern as ArticleForm.svelte.
	const initialValues = () => ({
		titleEn: data.product.localizations['en']?.title ?? '',
		descEn: data.product.localizations['en']?.descriptionMarkdown ?? '',
		titleTh: data.product.localizations['th']?.title ?? '',
		descTh: data.product.localizations['th']?.descriptionMarkdown ?? '',
		vendor: data.product.vendor ?? '',
		productType: data.product.productType ?? '',
		// Per-variant editable fields, keyed by variant id. Money is
		// edited as baht strings (what the input shows), converted
		// server-side by parseBahtToSatang.
		variantFields: Object.fromEntries(
			data.product.variants.map((v) => [
				v.id,
				{
					price: satangToBahtInput(v.priceSatang),
					compareAt: v.compareAtSatang != null ? satangToBahtInput(v.compareAtSatang) : '',
					sku: v.sku ?? ''
				}
			])
		),
		// #165 — bundle config. Components hang off the first variant
		// (see the note in the save action). Quantities are edited as
		// strings because that is what an <input> holds; the server
		// validates them as whole numbers.
		isBundle: data.product.isBundle,
		bundleComponents: (data.product.variants[0]?.bundleComponents ?? []).map((c) => ({
			variantId: c.componentVariantId,
			quantity: String(c.quantity)
		}))
	});
	const seed = initialValues();

	let titleEn = $state(seed.titleEn);
	let descEn = $state(seed.descEn);
	let titleTh = $state(seed.titleTh);
	let descTh = $state(seed.descTh);
	let vendor = $state(seed.vendor);
	let productType = $state(seed.productType);
	let variantFields = $state(seed.variantFields);
	let isBundle = $state(seed.isBundle);
	let bundleComponents = $state(seed.bundleComponents);
	let saving = $state(false);

	// ── Bundle component picker (#165) ──────────────────────
	// Candidates are pre-filtered server-side to active, non-bundle
	// variants outside this product, so nothing offered here can be
	// rejected by the recursion guard.
	const candidates = $derived(data.bundleCandidates);
	const chosenIds = $derived(new Set(bundleComponents.map((c) => c.variantId)));

	function addComponent() {
		bundleComponents = [...bundleComponents, { variantId: '', quantity: '1' }];
	}

	function removeComponent(index: number) {
		bundleComponents = bundleComponents.filter((_, i) => i !== index);
	}

	/**
	 * How many bundles current stock can make — the same
	 * min(floor(available / qty)) the server derives, mirrored here so
	 * the merchant sees the consequence of a quantity edit before
	 * saving. Purely advisory; the server recomputes on every read.
	 */
	const bundleAvailability = $derived.by(() => {
		if (!isBundle || bundleComponents.length === 0) return 0;
		let min = Infinity;
		for (const row of bundleComponents) {
			const candidate = candidates.find((c) => c.variantId === row.variantId);
			if (!candidate) continue;
			const qty = Number(row.quantity);
			if (!Number.isInteger(qty) || qty <= 0) continue;
			if (candidate.available === null) continue;
			min = Math.min(min, Math.floor(candidate.available / qty));
		}
		return min === Infinity ? 0 : Math.max(0, min);
	});

	// Dirty tracking drives the SaveBar's visibility and the
	// navigate-away guard (see dirty-state.svelte.ts for why the
	// snapshot is a serialised string).
	const snapshot = () =>
		JSON.stringify([
			titleEn,
			descEn,
			titleTh,
			descTh,
			vendor,
			productType,
			Object.entries(variantFields).map(([id, f]) => [id, f.price, f.compareAt, f.sku]),
			isBundle,
			bundleComponents.map((c) => [c.variantId, c.quantity])
		]);
	const dirty = new DirtyState(snapshot());
	$effect(() => dirty.update(snapshot()));
	guardUnsavedChanges(() => dirty.dirty, m.admin_leave_confirm());

	function discard() {
		const fresh = initialValues();
		titleEn = fresh.titleEn;
		descEn = fresh.descEn;
		titleTh = fresh.titleTh;
		descTh = fresh.descTh;
		vendor = fresh.vendor;
		productType = fresh.productType;
		variantFields = fresh.variantFields;
		isBundle = fresh.isBundle;
		bundleComponents = fresh.bundleComponents;
		dirty.reset(snapshot());
	}

	const variantColumns: Column<Variant>[] = [
		{ key: 'title', header: m.shop_admin_col_title(), cell: variantTitleCell },
		{ key: 'sku', header: m.shop_admin_col_sku(), cell: skuCell },
		{ key: 'price', header: m.shop_admin_col_price(), align: 'right', numeric: true, cell: priceCell },
		{
			key: 'compareAt',
			header: m.shop_admin_col_compare_at(),
			align: 'right',
			numeric: true,
			cell: compareAtCell
		},
		{ key: 'onHand', header: m.shop_admin_col_on_hand(), align: 'right', numeric: true, cell: onHandCell },
		{
			key: 'reserved',
			header: m.shop_admin_col_reserved(),
			align: 'right',
			numeric: true,
			cell: reservedCell
		},
		{
			key: 'available',
			header: m.shop_admin_col_available(),
			align: 'right',
			numeric: true,
			cell: availableCell
		},
		{ key: 'adjust', header: m.shop_admin_col_adjust(), class: 'w-40', cell: adjustCell }
	];
</script>

{#snippet variantTitleCell(variant: Variant)}
	<span class="font-medium">{variant.titleCached || m.shop_admin_default_variant()}</span>
	{#if variant.status === 'archived'}
		<Badge variant="outline" class="ml-2">{m.status_archived()}</Badge>
	{/if}
{/snippet}

<!--
	Variant fields live inside the DataTable, which also hosts the
	per-row adjust-inventory <form>. Nesting forms is invalid HTML, so
	these inputs associate with the main editor form via the `form`
	attribute instead of containment.
-->
{#snippet skuCell(variant: Variant)}
	<Input
		name={`variant_${variant.id}_sku`}
		form="product-save-form"
		bind:value={variantFields[variant.id].sku}
		placeholder="—"
		class="h-8 w-28 font-mono text-xs"
	/>
{/snippet}

{#snippet priceCell(variant: Variant)}
	<Input
		name={`variant_${variant.id}_price`}
		form="product-save-form"
		inputmode="decimal"
		pattern={'[0-9]+(\\.[0-9]{1,2})?'}
		required
		bind:value={variantFields[variant.id].price}
		class="h-8 w-24 text-right text-xs tabular-nums"
	/>
{/snippet}

{#snippet compareAtCell(variant: Variant)}
	<Input
		name={`variant_${variant.id}_compare_at`}
		form="product-save-form"
		inputmode="decimal"
		pattern={'[0-9]+(\\.[0-9]{1,2})?'}
		bind:value={variantFields[variant.id].compareAt}
		placeholder="—"
		class="h-8 w-24 text-right text-xs tabular-nums"
	/>
{/snippet}

{#snippet onHandCell(variant: Variant)}
	{variant.inventory?.onHand ?? '—'}
{/snippet}

{#snippet reservedCell(variant: Variant)}
	{variant.inventory?.reserved ?? '—'}
{/snippet}

{#snippet availableCell(variant: Variant)}
	{#if variant.inventory}
		<span
			class={variant.inventory.available > 0
				? 'text-green-700 dark:text-green-400'
				: 'text-destructive'}
		>
			{variant.inventory.available}
		</span>
	{:else}
		—
	{/if}
{/snippet}

{#snippet adjustCell(variant: Variant)}
	<form method="POST" action="?/adjustInventory" use:enhance class="flex gap-1">
		<input type="hidden" name="variantId" value={variant.id} />
		<Input type="number" name="delta" placeholder="±N" class="h-8 w-20 text-xs" />
		<Button type="submit" size="sm" variant="outline">{m.shop_admin_apply()}</Button>
	</form>
{/snippet}

<PageShell>
	<PageHeader
		title={enTitle}
		description={product.slug}
		icon={Package}
		breadcrumbs={[
			{ label: m.shop_admin_products(), href: resolve('/(admin)/admin/shop/products') },
			{ label: enTitle }
		]}
	>
		{#snippet actions()}
			<StatusBadge status={product.status} />
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div
				class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
			>
				{form.error}
			</div>
		{/if}
		{#if form?.success && form.message}
			<div
				class="rounded-md border border-green-600/50 bg-green-100 p-3 text-sm text-green-800 dark:bg-green-500/15 dark:text-green-300"
			>
				{form.message}
			</div>
		{/if}

		<form
			id="product-save-form"
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
			<!-- Both locales side by side — the localization pattern from the
			     registry entry editor / ArticleForm. -->
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
					</div>
					<div class="space-y-2">
						<Label for="description_en">{m.shop_admin_description()}</Label>
						<textarea
							id="description_en"
							name="description_en"
							rows="6"
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
							rows="6"
							bind:value={descTh}
							class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
							disabled={saving}
						></textarea>
					</div>
				</section>
			</div>

			<section class="space-y-4 rounded-lg border border-border p-4">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					{m.shop_admin_details()}
				</h2>
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="space-y-2">
						<Label for="vendor">{m.shop_admin_vendor()}</Label>
						<Input id="vendor" name="vendor" maxlength={200} bind:value={vendor} disabled={saving} />
					</div>
					<div class="space-y-2">
						<Label for="product_type">{m.shop_admin_product_type()}</Label>
						<Input
							id="product_type"
							name="product_type"
							maxlength={200}
							bind:value={productType}
							disabled={saving}
						/>
					</div>
				</div>
			</section>

			<!-- ─── Bundle contents (#165) ─────────────────────────
			     The bundle's PRICE is edited in the variants table like
			     any other variant's — it is fixed and authoritative, not
			     a sum of what is picked here. This section only decides
			     which stock a sale draws down. -->
			<section class="space-y-4 rounded-lg border border-border p-4">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					{m.shop_admin_bundle_section()}
				</h2>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="is_bundle"
						bind:checked={isBundle}
						disabled={saving}
						class="h-4 w-4 rounded border-input"
					/>
					{m.shop_admin_is_bundle()}
				</label>
				<p class="text-xs text-muted-foreground">{m.shop_admin_bundle_help()}</p>

				{#if isBundle}
					{#if candidates.length === 0}
						<p class="text-sm text-muted-foreground">{m.shop_admin_bundle_no_candidates()}</p>
					{:else}
						{#if bundleComponents.length === 0}
							<p class="text-sm text-muted-foreground">{m.shop_admin_bundle_none()}</p>
						{/if}
						<div class="space-y-2">
							{#each bundleComponents as component, index (index)}
								<div class="flex items-end gap-2">
									<div class="flex-1 space-y-1">
										<Label for={`bundle_component_${index}`} class="text-xs">
											{m.shop_admin_bundle_component()}
										</Label>
										<select
											id={`bundle_component_${index}`}
											name="bundle_component_variant"
											bind:value={component.variantId}
											disabled={saving}
											class="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<option value="">{m.shop_admin_bundle_choose()}</option>
											{#each candidates as candidate (candidate.variantId)}
												<!-- Already-picked variants are hidden from the
												     other rows: a duplicate component is rejected
												     server-side, so it must not be offerable. -->
												{#if candidate.variantId === component.variantId || !chosenIds.has(candidate.variantId)}
													<option value={candidate.variantId}>
														{candidate.productTitle}{candidate.variantTitle
															? ` — ${candidate.variantTitle}`
															: ''}{candidate.sku ? ` (${candidate.sku})` : ''}
													</option>
												{/if}
											{/each}
										</select>
									</div>
									<div class="w-32 space-y-1">
										<Label for={`bundle_qty_${index}`} class="text-xs">
											{m.shop_admin_bundle_quantity()}
										</Label>
										<Input
											id={`bundle_qty_${index}`}
											name="bundle_component_qty"
											type="number"
											min="1"
											step="1"
											bind:value={component.quantity}
											disabled={saving}
											class="h-9 text-right tabular-nums"
										/>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onclick={() => removeComponent(index)}
										disabled={saving}
									>
										{m.shop_admin_bundle_remove()}
									</Button>
								</div>
							{/each}
						</div>
						<div class="flex items-center justify-between gap-3">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onclick={addComponent}
								disabled={saving}
							>
								{m.shop_admin_bundle_add_component()}
							</Button>
							{#if bundleComponents.length > 0}
								<p class="text-xs tabular-nums text-muted-foreground">
									{m.shop_admin_bundle_availability({ count: bundleAvailability })}
								</p>
							{/if}
						</div>
					{/if}
				{/if}
			</section>
		</form>

		<section class="space-y-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_admin_variants()} ({product.variants.length})
			</h2>
			<DataTable columns={variantColumns} rows={product.variants} getKey={(v) => v.id}>
				{#snippet empty()}
					<p class="text-sm text-muted-foreground">{m.shop_admin_no_variants()}</p>
				{/snippet}
			</DataTable>
		</section>

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_admin_status_section()}
			</h2>
			<form method="POST" action="?/setStatus" use:enhance class="flex items-center gap-3">
				<Label for="status" class="sr-only">{m.shop_admin_status_section()}</Label>
				<select
					id="status"
					name="status"
					value={product.status}
					class="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					<option value="draft">{m.shop_admin_status_draft_option()}</option>
					<option value="active">{m.shop_admin_status_active_option()}</option>
					<option value="archived">{m.shop_admin_status_archived_option()}</option>
				</select>
				<Button type="submit" size="sm">{m.shop_admin_update()}</Button>
			</form>
		</section>

		<section class="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-destructive">
				{m.shop_admin_danger_zone()}
			</h2>
			<div class="flex items-start justify-between gap-4">
				<div>
					<p class="text-sm font-medium">{m.shop_admin_delete_product()}</p>
					<p class="text-xs text-muted-foreground">
						{m.shop_admin_delete_product_help()}
					</p>
				</div>
				<form
					method="POST"
					action="?/delete"
					use:enhance={() => async ({ update }) => {
						if (!confirm(m.shop_admin_delete_confirm({ title: enTitle }))) return;
						await update();
					}}
				>
					<Button type="submit" variant="destructive" size="sm">
						<Trash2 class="mr-2 h-4 w-4" />
						{m.shop_admin_delete()}
					</Button>
				</form>
			</div>
		</section>

		<!-- Sticky save affordance for the main editor form. The submit
		     button targets the form by id because the variant inputs (and
		     this bar) sit outside the form element itself. -->
		<SaveBar dirty={dirty.dirty} {saving} onDiscard={discard} formId="product-save-form" />
	</div>
</PageShell>
