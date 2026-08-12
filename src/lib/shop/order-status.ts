/**
 * Localized order-status labels, shared by the storefront surfaces that
 * render an order's status.
 *
 * The order-status page built this map inline, so the account page's
 * order history (which had no map) rendered the raw enum token — a Thai
 * customer read the literal string "fulfilled". One helper, both call
 * sites, no drift.
 *
 * Falls back to the raw token for statuses that predate (or postdate)
 * the message catalogue rather than rendering an empty label.
 */
import * as m from "$lib/paraglide/messages";

export function orderStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return m.shop_status_pending();
    case "paid":
      return m.shop_status_paid();
    case "fulfilled":
      return m.shop_status_fulfilled();
    case "delivered":
      return m.shop_status_delivered();
    case "refunded":
      return m.shop_status_refunded();
    case "cancelled":
      return m.shop_status_cancelled();
    default:
      return status;
  }
}
