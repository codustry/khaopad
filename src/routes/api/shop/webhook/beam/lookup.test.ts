import { describe, it, expect, vi } from "vitest";
import { findOrderForWebhook } from "./lookup";

/**
 * Pins the webhook order-matching order (#151): charge id first, then
 * the order number carried as Beam's `referenceId`. Before this
 * existed, the route looked up ONLY by provider_charge_id — which
 * holds the payment-LINK id at checkout time, so the first payment
 * webhook (carrying the real charge id) could never match and every
 * paid order stayed pending.
 */
describe("beam webhook order lookup (#151)", () => {
  const order = { id: "ord_1", orderNumber: "KP-2026-000123" };

  it("matches by providerChargeId first and skips the fallback", async () => {
    const byProviderChargeId = vi.fn().mockResolvedValue(order);
    const byOrderNumber = vi.fn();
    const found = await findOrderForWebhook(
      { providerChargeId: "ch_real", referenceId: "KP-2026-000123" },
      { byProviderChargeId, byOrderNumber },
    );
    expect(found).toBe(order);
    expect(byProviderChargeId).toHaveBeenCalledWith("ch_real");
    expect(byOrderNumber).not.toHaveBeenCalled();
  });

  it("falls back to referenceId when the charge id misses", async () => {
    // The first payment webhook: provider_charge_id holds the LINK id,
    // the webhook carries the real charge id — miss, then join on the
    // order number Beam echoes back.
    const byProviderChargeId = vi.fn().mockResolvedValue(undefined);
    const byOrderNumber = vi.fn().mockResolvedValue(order);
    const found = await findOrderForWebhook(
      { providerChargeId: "ch_real", referenceId: "KP-2026-000123" },
      { byProviderChargeId, byOrderNumber },
    );
    expect(found).toBe(order);
    expect(byOrderNumber).toHaveBeenCalledWith("KP-2026-000123");
  });

  it("skips the charge lookup entirely when chargeId is empty", async () => {
    const byProviderChargeId = vi.fn();
    const byOrderNumber = vi.fn().mockResolvedValue(order);
    const found = await findOrderForWebhook(
      { providerChargeId: "", referenceId: "KP-2026-000123" },
      { byProviderChargeId, byOrderNumber },
    );
    expect(found).toBe(order);
    expect(byProviderChargeId).not.toHaveBeenCalled();
  });

  it("returns undefined when both keys are absent", async () => {
    const byProviderChargeId = vi.fn();
    const byOrderNumber = vi.fn();
    const found = await findOrderForWebhook(
      {},
      { byProviderChargeId, byOrderNumber },
    );
    expect(found).toBeUndefined();
    expect(byProviderChargeId).not.toHaveBeenCalled();
    expect(byOrderNumber).not.toHaveBeenCalled();
  });

  it("returns undefined when both lookups miss", async () => {
    const found = await findOrderForWebhook(
      { providerChargeId: "ch_x", referenceId: "KP-x" },
      {
        byProviderChargeId: vi.fn().mockResolvedValue(undefined),
        byOrderNumber: vi.fn().mockResolvedValue(undefined),
      },
    );
    expect(found).toBeUndefined();
  });
});
