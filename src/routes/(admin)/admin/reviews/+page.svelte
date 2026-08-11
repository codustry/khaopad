<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { Badge, Button } from '$lib/components/ui';
	import {
		PageShell,
		PageHeader,
		DataTable,
		StatusBadge,
		type StatusTone
	} from '$lib/components/admin';
	import type { Column } from '$lib/components/admin/DataTable.svelte';
	import { Star } from 'lucide-svelte';
	import type { ProductReview, ReviewStatus } from '$plugins/reviews/schema';
	import type { PageData } from './$types';

	let { data, form }: { data: PageData; form: { ok?: boolean; error?: string } | null } =
		$props();

	// Admin copy is plain English by convention here (the C6 Thai sweep
	// owns admin i18n) — matching the shop settings card precedent.
	const tabs: Array<{ key: ReviewStatus; label: string }> = [
		{ key: 'pending', label: 'Pending' },
		{ key: 'approved', label: 'Approved' },
		{ key: 'rejected', label: 'Rejected' }
	];

	function toneFor(status: string): StatusTone {
		if (status === 'approved') return 'success';
		if (status === 'rejected') return 'danger';
		return 'warning';
	}

	function fmt(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	// Snippets are hoisted component-wide, so referencing them here from
	// the markup below works — same pattern as /admin/shop/orders.
	const columns: Column<ProductReview>[] = [
		{ key: 'rating', header: 'Rating', cell: ratingCell },
		{ key: 'review', header: 'Review', cell: reviewCell },
		{ key: 'product', header: 'Product', class: 'hidden md:table-cell', cell: productCell },
		{ key: 'createdAt', header: 'Submitted', class: 'hidden sm:table-cell', cell: dateCell },
		{ key: 'actions', header: '', align: 'right', cell: actionsCell }
	];
</script>

<svelte:head>
	<title>Reviews — {m.cms_app_name()}</title>
</svelte:head>

<PageShell>
	<PageHeader
		title="Reviews"
		description="Moderate customer product reviews. Approved reviews appear on the storefront and feed the product's aggregate rating."
		icon={Star}
	>
		{#snippet actions()}
			{#if data.pendingCount > 0}
				<Badge variant="default">{data.pendingCount} pending</Badge>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="space-y-6">
		{#if form?.error}
			<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				{form.error}
			</div>
		{/if}

		<!-- Status tabs -->
		<div class="flex gap-2 border-b border-border">
			{#each tabs as t (t.key)}
				<a
					href={resolve(`/(admin)/admin/reviews?status=${t.key}`)}
					class="-mb-px border-b-2 px-4 py-2 text-sm {data.status === t.key
						? 'border-primary font-medium text-foreground'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
				>
					{t.label}
				</a>
			{/each}
		</div>

		<DataTable
			{columns}
			rows={data.items}
			getKey={(r) => r.id}
			caption="Product reviews in the {data.status} state"
		>
			{#snippet empty()}
				<p class="text-sm text-muted-foreground">
					No {data.status} reviews.
				</p>
			{/snippet}
		</DataTable>

		{#if data.hasPrev || data.hasNext}
			<div class="flex items-center justify-between pt-2">
				{#if data.hasPrev}
					<Button
						href={resolve(`/(admin)/admin/reviews?status=${data.status}&page=${data.page - 1}`)}
						variant="outline"
						size="sm"
					>
						← {m.cms_audit_prev()}
					</Button>
				{:else}
					<span></span>
				{/if}
				{#if data.hasNext}
					<Button
						href={resolve(`/(admin)/admin/reviews?status=${data.status}&page=${data.page + 1}`)}
						variant="outline"
						size="sm"
					>
						{m.cms_audit_next()} →
					</Button>
				{/if}
			</div>
		{/if}
	</div>
</PageShell>

{#snippet ratingCell(r: ProductReview)}
	<div class="flex items-center gap-2">
		<span class="text-amber-500" aria-label="{r.rating} out of 5 stars">
			{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}
		</span>
		{#if r.verified === 1}
			<StatusBadge status="verified" tone="success" label="Verified" />
		{/if}
	</div>
{/snippet}

{#snippet reviewCell(r: ProductReview)}
	<div class="max-w-md space-y-1">
		<div class="flex items-center gap-2">
			<StatusBadge status={r.status} tone={toneFor(r.status)} />
			<span class="truncate text-sm font-medium">{r.title}</span>
		</div>
		<p class="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{r.body}</p>
		<p class="text-xs text-muted-foreground">{r.email}</p>
	</div>
{/snippet}

{#snippet productCell(r: ProductReview)}
	{@const product = data.productById[r.productId]}
	{#if product}
		<a
			href={resolve('/(admin)/admin/shop/products/[id]', { id: r.productId })}
			class="text-sm text-muted-foreground hover:text-foreground"
		>
			{product.title}
		</a>
	{:else}
		<span class="text-xs text-muted-foreground">{r.productId}</span>
	{/if}
{/snippet}

{#snippet dateCell(r: ProductReview)}
	<span class="text-xs tabular-nums text-muted-foreground">{fmt(r.createdAt)}</span>
{/snippet}

{#snippet actionsCell(r: ProductReview)}
	<div class="flex justify-end gap-2">
		{#if r.status !== 'approved'}
			<form method="POST" action="?/setStatus" use:enhance>
				<input type="hidden" name="id" value={r.id} />
				<input type="hidden" name="status" value="approved" />
				<Button type="submit" variant="outline" size="sm">Approve</Button>
			</form>
		{/if}
		{#if r.status !== 'rejected'}
			<form method="POST" action="?/setStatus" use:enhance>
				<input type="hidden" name="id" value={r.id} />
				<input type="hidden" name="status" value="rejected" />
				<Button type="submit" variant="destructive" size="sm">Reject</Button>
			</form>
		{/if}
	</div>
{/snippet}
