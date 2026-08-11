<script lang="ts">
	import { BarChart3, Download } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import { PageShell, PageHeader, DataTable, type Column } from '$lib/components/admin';
	import { formatSatang, type Satang } from '$plugins/shop/money';
	import * as m from '$lib/paraglide/messages';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type DayRow = PageData['report']['days'][number];

	const columns: Column<DayRow>[] = [
		{ key: 'date', header: m.shop_report_col_date(), cell: dateCell },
		{ key: 'orders', header: m.shop_report_col_orders(), align: 'right', numeric: true, cell: ordersCell },
		{ key: 'gross', header: m.shop_report_gross(), align: 'right', numeric: true, cell: grossCell },
		{ key: 'discounts', header: m.shop_report_discounts(), align: 'right', numeric: true, cell: discountsCell },
		{ key: 'net', header: m.shop_report_net(), align: 'right', numeric: true, cell: netCell },
		{ key: 'vat', header: m.shop_report_vat(), align: 'right', numeric: true, cell: vatCell },
		{ key: 'refunds', header: m.shop_report_refunds(), align: 'right', numeric: true, cell: refundsCell }
	];

	const csvHref = $derived(
		`/admin/reports/csv?from=${data.report.from}&to=${data.report.to}`
	);
</script>

{#snippet dateCell(r: DayRow)}
	<span class="font-mono text-xs">{r.date}</span>
{/snippet}
{#snippet ordersCell(r: DayRow)}{r.orders}{/snippet}
{#snippet grossCell(r: DayRow)}{formatSatang(r.grossSatang as Satang)}{/snippet}
{#snippet discountsCell(r: DayRow)}{formatSatang(r.discountSatang as Satang)}{/snippet}
{#snippet netCell(r: DayRow)}{formatSatang(r.netSatang as Satang)}{/snippet}
{#snippet vatCell(r: DayRow)}
	{#if r.vatExclusiveSatang > 0}
		<div>{formatSatang(r.vatExclusiveSatang as Satang)} <span class="text-xs text-muted-foreground">({m.shop_report_vat_exclusive_short()})</span></div>
	{/if}
	{#if r.vatIncludedSatang > 0}
		<div>{formatSatang(r.vatIncludedSatang as Satang)} <span class="text-xs text-muted-foreground">({m.shop_report_vat_included_short()})</span></div>
	{/if}
	{#if r.vatExclusiveSatang === 0 && r.vatIncludedSatang === 0}—{/if}
{/snippet}
{#snippet refundsCell(r: DayRow)}
	{r.refundSatang > 0 ? formatSatang(r.refundSatang as Satang) : '—'}
{/snippet}

<PageShell width="wide">
	<PageHeader title={m.shop_report_title()} icon={BarChart3} />

	<div class="space-y-6">
		<!-- ใบกำกับภาษี groundwork: merchant identity from site settings.
		     The full per-order tax-invoice document is deferred. -->
		{#if data.merchant.legalName || data.merchant.taxId}
			<div class="rounded-lg border border-border p-4 text-sm">
				{#if data.merchant.legalName}
					<div class="font-medium">{data.merchant.legalName}</div>
				{/if}
				{#if data.merchant.taxId}
					<div class="text-muted-foreground">
						{m.shop_report_tax_id()}: {data.merchant.taxId}
					</div>
				{/if}
			</div>
		{/if}

		<form method="GET" class="flex flex-wrap items-end gap-3">
			<div class="space-y-1">
				<Label for="from" class="text-xs">{m.shop_report_from()}</Label>
				<Input id="from" name="from" type="date" value={data.report.from} />
			</div>
			<div class="space-y-1">
				<Label for="to" class="text-xs">{m.shop_report_to()}</Label>
				<Input id="to" name="to" type="date" value={data.report.to} />
			</div>
			<Button type="submit" variant="secondary">{m.shop_report_apply()}</Button>
			<Button href={csvHref} variant="outline" data-sveltekit-preload-data="off">
				<Download class="mr-2 h-4 w-4" />
				{m.shop_report_export_csv()}
			</Button>
		</form>

		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
			{#snippet stat(label: string, value: string)}
				<div class="rounded-lg border border-border p-3">
					<div class="text-xs text-muted-foreground">{label}</div>
					<div class="mt-1 text-lg font-semibold tabular-nums">{value}</div>
				</div>
			{/snippet}
			{@render stat(m.shop_report_col_orders(), String(data.report.totals.orders))}
			{@render stat(m.shop_report_gross(), formatSatang(data.report.totals.grossSatang as Satang))}
			{@render stat(m.shop_report_discounts(), formatSatang(data.report.totals.discountSatang as Satang))}
			{@render stat(m.shop_report_net(), formatSatang(data.report.totals.netSatang as Satang))}
			{@render stat(
				data.report.totals.vatIncludedSatang > 0 && data.report.totals.vatExclusiveSatang === 0
					? m.shop_report_vat_included()
					: m.shop_report_vat_collected(),
				formatSatang(
					(data.report.totals.vatExclusiveSatang +
						data.report.totals.vatIncludedSatang) as Satang
				)
			)}
			{@render stat(m.shop_report_refunds(), formatSatang(data.report.totals.refundSatang as Satang))}
		</div>

		<p class="text-xs text-muted-foreground">{m.shop_report_vat_note()}</p>

		<section>
			<h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
				{m.shop_report_by_day()}
			</h2>
			<DataTable {columns} rows={data.report.days} getKey={(r) => r.date}>
				{#snippet empty()}
					<p class="text-sm text-muted-foreground">{m.shop_report_empty()}</p>
				{/snippet}
			</DataTable>
		</section>
	</div>
</PageShell>
