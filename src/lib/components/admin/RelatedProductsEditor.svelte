<script lang="ts">
	/**
	 * v3.4 federation editor — pick products + refKind to attach to an
	 * article. Submits as `refs[]=productId:refKind` form values so the
	 * server action parses without any JSON dance.
	 *
	 * Ships as a compact section in the article editor. When the shop
	 * plugin isn't enabled, productChoices arrives empty and the whole
	 * section shows a friendly disabled state.
	 */
	import { enhance } from '$app/forms';
	import { Package, Save } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';

	type RefKind = 'featured' | 'mentioned' | 'promoted';
	type ProductChoice = { id: string; title: string; slug: string };

	let {
		currentRefs,
		productChoices,
	}: {
		currentRefs: Array<{ productId: string; refKind: RefKind }>;
		productChoices: ProductChoice[];
	} = $props();

	// Build a local editable state: for each product, remember which
	// ref kind (if any) is currently selected. 'none' means unlinked.
	type Selection = 'none' | RefKind;
	const initial = $derived(
		new Map<string, Selection>(
			productChoices.map((p) => {
				const existing = currentRefs.find((r) => r.productId === p.id);
				return [p.id, (existing?.refKind ?? 'none') as Selection];
			}),
		),
	);
	// Writable $derived: reads through to `initial` (so a route nav
	// resets the editor to the new article's refs) but stays locally
	// assignable when the user picks a kind. Replaces the older
	// $state + $effect pair, which did the same thing less directly and
	// re-ran on every dependency change.
	let selection = $derived(new Map(initial));
	let submitting = $state(false);

	function setKind(productId: string, kind: Selection) {
		// Copy-then-assign rather than mutating in place: `selection` is a
		// $derived, so reassignment is what marks it dirty. The copy is a
		// plain Map because it's a throwaway that never itself needs to be
		// reactive — the assignment on the next line is the reactive step.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local throwaway; reactivity comes from reassigning the $derived below
		const next = new Map(selection);
		next.set(productId, kind);
		selection = next;
	}
</script>

<section class="space-y-4 rounded-lg border border-border p-4">
	<div class="flex items-center gap-3">
		<Package class="h-5 w-5 text-muted-foreground" />
		<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			Related products
		</h2>
	</div>

	{#if productChoices.length === 0}
		<p class="text-sm text-muted-foreground">
			No published products to link. When the shop plugin has active
			products, they'll appear here for cross-referencing.
		</p>
	{:else}
		<form
			method="POST"
			action="?/saveProductRefs"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					submitting = false;
				};
			}}
			class="space-y-3"
		>
			<!-- Submit one hidden input per non-'none' selection -->
			{#each Array.from(selection.entries()) as [productId, kind] (productId)}
				{#if kind !== 'none'}
					<input type="hidden" name="refs" value="{productId}:{kind}" />
				{/if}
			{/each}

			<div class="space-y-1 max-h-72 overflow-y-auto rounded border border-input p-2">
				{#each productChoices as product (product.id)}
					{@const currentKind = selection.get(product.id) ?? 'none'}
					<label class="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted">
						<span class="flex-1 truncate text-sm">
							{product.title}
							<code class="ml-1 text-xs text-muted-foreground">{product.slug}</code>
						</span>
						<select
							value={currentKind}
							onchange={(e) =>
								setKind(product.id, (e.target as HTMLSelectElement).value as Selection)}
							class="rounded border border-input bg-transparent px-2 py-1 text-xs"
							disabled={submitting}
						>
							<option value="none">—</option>
							<option value="featured">featured</option>
							<option value="mentioned">mentioned</option>
							<option value="promoted">promoted</option>
						</select>
					</label>
				{/each}
			</div>

			<div class="flex justify-end">
				<Button type="submit" size="sm" disabled={submitting}>
					<Save class="mr-2 h-3.5 w-3.5" />
					{submitting ? 'Saving…' : 'Save related products'}
				</Button>
			</div>

			<p class="text-xs text-muted-foreground">
				<strong>featured</strong> = hero product on the article ·
				<strong>mentioned</strong> = passing reference ·
				<strong>promoted</strong> = paid placement. All show as cards
				at the bottom of the article page.
			</p>
			<p class="text-xs text-muted-foreground">
				<!-- &lbrace;/&rbrace; entities rather than {'{'} mustaches: Svelte
				     treats a bare { as an expression delimiter, and the entity
				     form renders identically without a useless interpolation. -->
				Tip: use <code>:::product&lbrace;slug=your-product&rbrace;</code> in the
				article body to embed an inline product card in the middle of
				the content.
			</p>
		</form>
	{/if}
</section>
