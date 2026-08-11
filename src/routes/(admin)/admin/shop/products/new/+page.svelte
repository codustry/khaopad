<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { Package } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader } from '$lib/components/admin';
	import * as m from '$lib/paraglide/messages';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let submitting = $state(false);
</script>

<PageShell width="form">
	<PageHeader
		title={m.shop_admin_new_product()}
		icon={Package}
		breadcrumbs={[
			{ label: m.shop_admin_products(), href: resolve('/(admin)/admin/shop/products') },
			{ label: m.shop_admin_new_product() }
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
				{m.shop_admin_en_section()}
			</h2>
			<div class="space-y-2">
				<Label for="title_en">{m.shop_admin_title()}</Label>
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
				<Label for="description_en">{m.shop_admin_description()}</Label>
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
				{m.shop_admin_th_section()}
			</h2>
			<div class="space-y-2">
				<Label for="title_th">{m.shop_admin_title()}</Label>
				<Input
					id="title_th"
					name="title_th"
					maxlength={200}
					placeholder="เสื้อยืดคลาสสิก"
					disabled={submitting}
				/>
			</div>
			<div class="space-y-2">
				<Label for="description_th">{m.shop_admin_description()}</Label>
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
				{m.shop_admin_pricing_inventory()}
			</h2>
			<div class="grid grid-cols-2 gap-4">
				<div class="space-y-2">
					<Label for="price">{m.shop_admin_price_baht()}</Label>
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
					<Label for="sku">{m.shop_admin_sku_optional()}</Label>
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
				{m.shop_admin_new_product_help()}
			</p>
		</section>

		<section class="space-y-4 rounded-lg border border-border p-4">
			<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_admin_status_section()}
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
					<span class="text-sm">{m.shop_admin_status_draft_option()}</span>
				</label>
				<label class="flex items-center gap-2">
					<input
						type="radio"
						name="status"
						value="active"
						disabled={submitting}
					/>
					<span class="text-sm">{m.shop_admin_status_active_option()}</span>
				</label>
			</div>
		</section>

		<div class="flex justify-end gap-2">
			<Button href={resolve('/(admin)/admin/shop/products')} variant="outline">{m.shop_admin_cancel()}</Button>
			<Button type="submit" disabled={submitting}>
				{submitting ? m.shop_admin_creating() : m.shop_admin_create_product()}
			</Button>
		</div>
	</form>
</PageShell>
