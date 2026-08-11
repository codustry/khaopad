/**
 * Finance report (D5) — daily aggregates over shop_orders + the
 * shop_order_adjustments refund ledger, for /admin/reports.
 *
 * Semantics (deliberate, documented so the numbers are defensible):
 *
 *   - An order counts on the DAY IT WAS CREATED (created_at, UTC) and
 *     only when money was actually collected: financial_status IN
 *     ('paid', 'partially_refunded', 'refunded'). Pending orders are
 *     not revenue; cancelled orders never collected.
 *   - gross      = Σ (subtotal + shipping) — the pre-discount
 *                  consideration charged for goods + delivery.
 *   - discounts  = Σ discount_satang.
 *   - net        = gross − discounts (net sales; VAT reported
 *                  separately below, per mode).
 *   - VAT collected is labeled BY MODE, because the two columns mean
 *     different things (#107):
 *       exclusive orders → Σ tax_satang           (VAT added on top)
 *       inclusive orders → Σ tax_included_satang  (VAT broken out of
 *                          the sticker price — informational, already
 *                          inside net)
 *     Orders created before migration 0028 in inclusive mode have no
 *     recoverable breakout and report 0.
 *   - refunds    = Σ |amount_satang| of ledger rows with kind IN
 *                  ('refund_full','refund_partial'), counted on the
 *                  DAY THE REFUND WAS RECORDED (the ledger row's
 *                  created_at) — a March refund of a January order is
 *                  March money movement.
 *
 * All satang, all integer, no floats anywhere.
 *
 * ใบกำกับภาษี groundwork: the report header shows the merchant's legal
 * name + tax id (site settings). The full tax-invoice DOCUMENT
 * (per-order ใบกำกับภาษีเต็มรูป with running numbers) is explicitly
 * deferred — this report only proves the per-order VAT data is now
 * persisted and aggregatable.
 */

export type FinanceDayRow = {
  /** YYYY-MM-DD (UTC). */
  date: string;
  orders: number;
  grossSatang: number;
  discountSatang: number;
  netSatang: number;
  vatExclusiveSatang: number;
  vatIncludedSatang: number;
  refundSatang: number;
};

export type FinanceReport = {
  /** Inclusive YYYY-MM-DD bounds. */
  from: string;
  to: string;
  totals: Omit<FinanceDayRow, "date">;
  /** Ascending by date; only days with activity appear. */
  days: FinanceDayRow[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate + default the report range. Defaults to this month (UTC). */
export function resolveReportRange(
  fromParam: string | null,
  toParam: string | null,
  now: Date = new Date(),
): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = fromParam && DATE_RE.test(fromParam) ? fromParam : monthStart;
  const to = toParam && DATE_RE.test(toParam) ? toParam : today;
  // A reversed range aggregates nothing — normalize instead of erroring.
  return from <= to ? { from, to } : { from: to, to: from };
}

export async function buildFinanceReport(
  d1: D1Database,
  range: { from: string; to: string },
): Promise<FinanceReport> {
  // ISO-8601 strings compare lexicographically, so substr(created_at,
  // 1, 10) BETWEEN two YYYY-MM-DD bounds is an exact UTC-day filter.
  const orderRows = await d1
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS orders,
              SUM(subtotal_satang + shipping_satang) AS gross,
              SUM(discount_satang) AS discounts,
              SUM(CASE WHEN tax_mode = 'exclusive' THEN tax_satang ELSE 0 END) AS vat_exclusive,
              SUM(CASE WHEN tax_mode = 'inclusive' THEN tax_included_satang ELSE 0 END) AS vat_included
         FROM shop_orders
        WHERE financial_status IN ('paid', 'partially_refunded', 'refunded')
          AND substr(created_at, 1, 10) BETWEEN ?1 AND ?2
        GROUP BY day
        ORDER BY day ASC`,
    )
    .bind(range.from, range.to)
    .all<{
      day: string;
      orders: number;
      gross: number;
      discounts: number;
      vat_exclusive: number;
      vat_included: number;
    }>();

  const refundRows = await d1
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(ABS(amount_satang)) AS refunds
         FROM shop_order_adjustments
        WHERE kind IN ('refund_full', 'refund_partial')
          AND substr(created_at, 1, 10) BETWEEN ?1 AND ?2
        GROUP BY day
        ORDER BY day ASC`,
    )
    .bind(range.from, range.to)
    .all<{ day: string; refunds: number }>();

  const byDay = new Map<string, FinanceDayRow>();
  const day = (date: string): FinanceDayRow => {
    let row = byDay.get(date);
    if (!row) {
      row = {
        date,
        orders: 0,
        grossSatang: 0,
        discountSatang: 0,
        netSatang: 0,
        vatExclusiveSatang: 0,
        vatIncludedSatang: 0,
        refundSatang: 0,
      };
      byDay.set(date, row);
    }
    return row;
  };
  for (const r of orderRows.results) {
    const row = day(r.day);
    row.orders = r.orders;
    row.grossSatang = r.gross ?? 0;
    row.discountSatang = r.discounts ?? 0;
    row.netSatang = row.grossSatang - row.discountSatang;
    row.vatExclusiveSatang = r.vat_exclusive ?? 0;
    row.vatIncludedSatang = r.vat_included ?? 0;
  }
  for (const r of refundRows.results) {
    day(r.day).refundSatang = r.refunds ?? 0;
  }

  const days = [...byDay.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const totals = days.reduce(
    (acc, r) => ({
      orders: acc.orders + r.orders,
      grossSatang: acc.grossSatang + r.grossSatang,
      discountSatang: acc.discountSatang + r.discountSatang,
      netSatang: acc.netSatang + r.netSatang,
      vatExclusiveSatang: acc.vatExclusiveSatang + r.vatExclusiveSatang,
      vatIncludedSatang: acc.vatIncludedSatang + r.vatIncludedSatang,
      refundSatang: acc.refundSatang + r.refundSatang,
    }),
    {
      orders: 0,
      grossSatang: 0,
      discountSatang: 0,
      netSatang: 0,
      vatExclusiveSatang: 0,
      vatIncludedSatang: 0,
      refundSatang: 0,
    },
  );

  return { from: range.from, to: range.to, days, totals };
}

/**
 * CSV export — one row per day plus a TOTAL row. Amounts stay in
 * integer satang (the unit every other export and the DB use); the
 * column names say so, so a spreadsheet user divides by 100 knowingly
 * rather than us shipping floats.
 */
export function financeReportToCsv(report: FinanceReport): string {
  const header = [
    "date",
    "orders",
    "gross_satang",
    "discounts_satang",
    "net_satang",
    "vat_exclusive_satang",
    "vat_included_satang",
    "refunds_satang",
  ].join(",");
  const line = (label: string, r: Omit<FinanceDayRow, "date">) =>
    [
      label,
      r.orders,
      r.grossSatang,
      r.discountSatang,
      r.netSatang,
      r.vatExclusiveSatang,
      r.vatIncludedSatang,
      r.refundSatang,
    ].join(",");
  return [
    header,
    ...report.days.map((r) => line(r.date, r)),
    line("TOTAL", report.totals),
  ].join("\n");
}
