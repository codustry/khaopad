/**
 * Pins the checkout extension seam (#174 Step 3, #171).
 *
 * The seam's promise is that a deployment can add market-specific fields to
 * checkout WITHOUT forking it — so the engine keeps shipping payment and
 * inventory fixes to every install. These tests hold that promise to its two
 * halves: the registry works, and the checkout page actually consults it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateOrderAddress } from "$lib/shop/address-validation";
import {
  registerCheckoutSlots,
  getCheckoutSlots,
  __resetCheckoutSlotsForTests,
} from "./checkout-extensions";

const CHECKOUT = readFileSync(
  join(process.cwd(), "src/routes/(www)/[locale]/checkout/+page.svelte"),
  "utf8",
);

afterEach(() => __resetCheckoutSlotsForTests());

describe("checkout slot registry", () => {
  it("is empty by default so an unconfigured install renders stock checkout", () => {
    expect(getCheckoutSlots()).toEqual({});
  });

  it("merges successive registrations", () => {
    // Two plugins may each contribute a slot; the second must not wipe the
    // first.
    const A = (() => {}) as never;
    const B = (() => {}) as never;
    registerCheckoutSlots({ beforeContact: A });
    registerCheckoutSlots({ beforePayment: B });
    expect(getCheckoutSlots()).toEqual({ beforeContact: A, beforePayment: B });
  });
});

describe("checkout page — slot wiring", () => {
  it("renders all three documented slots", () => {
    // A slot declared in the type but never rendered would be a seam that
    // silently does nothing — the exact failure mode Step 2 hit.
    for (const slot of ["beforeContact", "afterAddress", "beforePayment"]) {
      expect(CHECKOUT).toContain(`slots.${slot}`);
    }
  });

  it("lets a slot block submission, but only after the engine's own checks", () => {
    // Order matters: email and address validation run first, so a slot can
    // never suppress them. It can only add a reason to stop.
    const emailCheck = CHECKOUT.indexOf("shop_err_invalid_email");
    const addrCheck = CHECKOUT.indexOf("shop_addr_incomplete");
    const slotCheck = CHECKOUT.indexOf("if (slotError)");
    expect(slotCheck).toBeGreaterThan(emailCheck);
    expect(slotCheck).toBeGreaterThan(addrCheck);
  });

  it("forwards a contributed billingAddress to checkout/start", () => {
    expect(CHECKOUT).toContain("slotContribution.billingAddress");
    expect(CHECKOUT).toMatch(
      /billingAddress:\s*slotContribution\.billingAddress/,
    );
  });

  it("tax-entity fields survive the validator round trip (#171)", () => {
    // History: the contribution type once declared these fields while the
    // validator silently dropped them — tax data vanished between browser
    // and order row with no error anywhere. They are back only because the
    // whole path now exists. This test IS that path: if a field is in the
    // slot contract, the validator must forward it.
    const address = validateOrderAddress({
      name: "Somchai Trading Co., Ltd.",
      line1: "88 Sukhumvit Rd",
      city: "Bangkok",
      postalCode: "10110",
      countryCode: "TH",
      entityName: "Somchai Trading Co., Ltd.",
      taxId: "0105536112233",
      branchCode: "00001",
    });
    expect(address.ok).toBe(true);
    if (address.ok) {
      expect(address.address.entityName).toBe("Somchai Trading Co., Ltd.");
      expect(address.address.taxId).toBe("0105536112233");
      expect(address.address.branchCode).toBe("00001");
    }
    // The metadata channel remains deliberately absent — nothing stores it.
    expect(CHECKOUT).not.toContain("slotContribution.metadata");
  });

  it("keeps money and payment out of slot reach", () => {
    // Slots receive the total for display; they must not be able to set it.
    // Everything price-related stays server-recomputed in checkout/start.
    expect(CHECKOUT).toContain("totalSatang: displayTotalSatang");
    expect(CHECKOUT).not.toMatch(
      /slotContribution\.(total|price|amount|discount)/,
    );
  });
});
