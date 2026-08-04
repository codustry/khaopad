/**
 * Order-matching for Beam webhooks (#151), extracted so the lookup
 * ORDER is unit-testable without a D1 binding.
 *
 * Why two keys: checkout stores the payment-link id in
 * `provider_charge_id` (a charge doesn't exist yet when the link is
 * created). The webhook that reports the payment carries the REAL
 * `chargeId` — which therefore can never match the stored link id on
 * the first event. Beam echoes our `order.referenceId` (the order
 * number) in every webhook, so:
 *
 *   1. try `provider_charge_id` — matches once markPaid has persisted
 *      the real charge id (webhook retries, refund echoes);
 *   2. fall back to the order number via `referenceId` — the join key
 *      for the FIRST payment webhook.
 *
 * Injectable finders instead of a drizzle handle so the test asserts
 * ordering and short-circuiting with plain stubs.
 */
export type WebhookOrderKeys = {
  /** Real Beam charge id from the webhook body — may be empty. */
  providerChargeId?: string;
  /** Our order number, echoed back by Beam — may be absent. */
  referenceId?: string;
};

export async function findOrderForWebhook<T>(
  keys: WebhookOrderKeys,
  finders: {
    byProviderChargeId: (id: string) => Promise<T | undefined>;
    byOrderNumber: (orderNumber: string) => Promise<T | undefined>;
  },
): Promise<T | undefined> {
  if (keys.providerChargeId) {
    const byCharge = await finders.byProviderChargeId(keys.providerChargeId);
    if (byCharge) return byCharge;
  }
  if (keys.referenceId) {
    return finders.byOrderNumber(keys.referenceId);
  }
  return undefined;
}
