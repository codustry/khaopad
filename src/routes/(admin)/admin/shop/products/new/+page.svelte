<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Package } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let submitting = $state(false);
</script>

<PageShell width="form">
	<PageHeader
		title="New product"
		icon={Package}
		breadcrumbs={[
			{ label: 'Products', href: resolve('/(admin)/admin/shop/products') },
			{ label: 'New product' }
		]}
	/>

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		}}
		class="space-y-6"
	>
		{#if form?.error}
			<div class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
				{form.error}
			</div>
		{/if}

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				English (required)
			</h2>
			<div class="space-y-2">
				<Label for="title_en">Title</Label>
				<Input
					id="title_en"
					name="title_en"
					required
					maxlength={200}
					placeholder="Classic Tee"
					disabled={submitting}
				/>
			</div>
			<div class="space-y-2">
				<Label for="description_en">Description (markdown)</Label>
				<textarea
					id="description_en"
					name="description_en"
					rows="4"
					class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
					disabled={submitting}
				></textarea>
			</div>
		</section>

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Thai (optional)
			</h2>
			<div class="space-y-2">
				<Label for="title_th">ชื่อสินค้า</Label>
				<Input
					id="title_th"
					name="title_th"
					maxlength={200}
					placeholder="เสื้อยืดคลาสสิก"
					disabled={submitting}
				/>
			</div>
			<div class="space-y-2">
				<Label for="description_th">คำอธิบาย (markdown)</Label>
				<textarea
					id="description_th"
					name="description_th"
					rows="4"
					class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
					disabled={submitting}
				></textarea>
			</div>
		</section>

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Pricing + inventory
			</h2>
			<div class="grid grid-cols-2 gap-4">
				<div class="space-y-2">
					<Label for="price">Price (฿)</Label>
					<Input
						id="price"
						name="price"
						required
						inputmode="decimal"
						pattern={'[0-9]+(\\.[0-9]{1,2})?'}
						placeholder="199.00"
						disabled={submitting}
					/>
				</div>
				<div class="space-y-2">
					<Label for="sku">SKU (optional)</Label>
					<Input
						id="sku"
						name="sku"
						maxlength={100}
						placeholder="CT-001"
						disabled={submitting}
					/>
				</div>
			</div>
			<p class="text-xs text-muted-foreground">
				Options + variant grid can be added on the edit page after creation.
				Inventory stays at 0 until you set it via the inventory adjustment
				action.
			</p>
		</section>

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				Status
			</h2>
			<div class="flex gap-3">
				<label class="flex items-center gap-2">
					<input
						type="radio"
						name="status"
						value="draft"
						checked
						disabled={submitting}
					/>
					<span class="text-sm">Draft (invisible to public)</span>
				</label>
				<label class="flex items-center gap-2">
					<input
						type="radio"
						name="status"
						value="active"
						disabled={submitting}
					/>
					<span class="text-sm">Active (published)</span>
				</label>
			</div>
		</section>

		<div class="flex justify-end gap-2">
			<Button href={resolve('/(admin)/admin/shop/products')} variant="outline">Cancel</Button>
			<Button type="submit" disabled={submitting}>
				{submitting ? 'Creating…' : 'Create product'}
			</Button>
		</div>
	</form>
</PageShell>
