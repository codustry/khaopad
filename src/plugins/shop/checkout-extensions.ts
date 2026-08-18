/**
 * Checkout extension points — Step 3 of the theme/engine split (#174, #171).
 *
 * WHY CHECKOUT GETS SLOTS AND NOT A FORK
 *
 * #171 read as "checkout needs a seam because market-specific fields need
 * forking." Measuring the real fork said otherwise: after upgrading, the team
 * took upstream's checkout wholesale and re-applied their work on top, and the
 * surviving delta was **75 lines, purely additive, in 4 places** — a Thai tax
 * invoice block (entity name, tax ID, branch code). Their own comment records
 * the design: the entity details ride along in the `billingAddress` that
 * `/api/shop/checkout/start` already accepts and validates.
 *
 * So the requirement is "insert fields and contribute data", not "rewrite the
 * flow". Slots cover it, and keeping checkout engine-owned means a payment or
 * inventory fix reaches every deployment. v4.0.1 alone fixed two shoppers
 * racing the last unit of stock and a Stripe dashboard refund booking the
 * wrong amount; a deployment that had forked checkout would still have both,
 * and no way to receive the fix.
 *
 * Shopify reached the same conclusion the expensive way — it deprecated
 * `checkout.liquid` and forcibly reverted non-migrating merchants to stock
 * checkout rather than keep a file-override surface over payment code.
 *
 * WHAT A SLOT CAN AND CANNOT DO
 *
 * Can: render fields, collect input, contribute a `billingAddress` and
 * arbitrary `metadata` to the order, and block submission with a validation
 * message.
 *
 * Cannot: change line items, prices, totals, tax, shipping cost, or the
 * payment call. Those stay in engine code and in `/api/shop/checkout/start`,
 * which re-validates everything server-side regardless of what a slot sends —
 * a slot is a UI contribution, never a trusted input.
 */
import type { Component } from "svelte";

/** Where a contributed component renders in the checkout form. */
export type CheckoutSlotName =
  /** Above the email field — market notices, trust badges, delivery promises. */
  | "beforeContact"
  /** Below the shipping address block — tax invoice, delivery instructions. */
  | "afterAddress"
  /** Immediately above the pay button — final consents, terms checkboxes. */
  | "beforePayment";

/**
 * What a slot component may contribute back to the order.
 *
 * `billingAddress` is exactly the shape `/api/shop/checkout/start` already
 * accepts and validates — no more. `validateOrderAddress`
 * (`$lib/shop/address-validation.ts`) builds a fresh object from a known
 * field list and **drops unknown keys silently**, so a tax id added here
 * would vanish between the browser and the order row with no error anywhere.
 * That is the exact silent-data-loss failure this seam exists to prevent, so
 * the type deliberately mirrors the validator rather than wishing for fields.
 *
 * ── KNOWN LIMITATION, stated rather than hidden ──
 *
 * There is NO order-metadata channel in this codebase today: no `metadata`
 * column, no order-service field, nothing in checkout/start. So a slot can
 * currently contribute only what a billing address can carry.
 *
 * That means a Thai ใบกำกับภาษี (entity name, tax id, branch code) can be
 * COLLECTED and VALIDATED by a slot, and the buyer's billing address stored,
 * but the tax identifiers themselves have nowhere to persist. Closing that
 * needs a coordinated engine change — add the fields to REQUIRED/OPTIONAL_FIELDS
 * in the validator, to OrderAddress, and to the order schema (a migration).
 *
 * It is deliberately NOT faked with a pass-through that the validator would
 * silently drop: a slot appearing to save tax data that never lands is worse
 * than a slot that cannot save it, because nobody would notice until an
 * accountant asked for the invoices. Tracked in #171.
 */
export type CheckoutContribution = {
  billingAddress?: {
    name?: string;
    line1?: string;
    line2?: string | null;
    city?: string;
    region?: string | null;
    postalCode?: string;
    countryCode?: string;
    phone?: string | null;
  };
};

/**
 * Props every slot component receives. Read-only view of checkout state plus
 * the two callbacks that make a slot useful.
 */
export type CheckoutSlotProps = {
  locale: string;
  /** Buyer email as currently entered. */
  email: string;
  /** True when the buyer is shipping (rather than a digital-only cart). */
  shipToAddress: boolean;
  /** Order total in satang, for slots that display or gate on it. */
  totalSatang: number;
  /**
   * Contribute data to the order. Call whenever the slot's own state changes;
   * the last value before submit is what is sent. Passing `{}` clears.
   */
  contribute: (contribution: CheckoutContribution) => void;
  /**
   * Block or unblock submission. Pass a message to block with that error
   * shown to the buyer; pass null when the slot's fields are valid.
   *
   * This is the one place a slot can stop a checkout, and it is deliberately
   * limited to the slot's OWN validity — it cannot suppress the engine's
   * validation of email, address or stock.
   */
  setValidity: (error: string | null) => void;
};

export type CheckoutSlots = Partial<
  Record<CheckoutSlotName, Component<CheckoutSlotProps>>
>;

/**
 * `var`, deliberately — see `$lib/components/www/chrome.ts` and
 * `$lib/components/admin/sidebar-nav.ts` for the incident history. A bundler
 * may hoist a deployment's registration above this declaration, and with
 * `let` that is a TDZ ReferenceError on every route.
 */
// eslint-disable-next-line no-var
var _slots: CheckoutSlots | undefined;

/**
 * Register checkout slot components. Call at module-load time from
 * `src/lib/plugins/registrations.ts` (or a module it imports) — that file is
 * loaded by BOTH the server and the storefront client bundle, which is what
 * keeps a slot consistent across SSR and hydration. A slot registered
 * anywhere only the server loads renders during SSR, disappears at
 * hydration, and its contribute/setValidity callbacks never run at all.
 *
 * Successive calls merge, so different plugins can each contribute a slot.
 */
export function registerCheckoutSlots(slots: CheckoutSlots): void {
  _slots = { ..._slots, ...slots };
}

/** Read registered slots. Empty object when none — checkout renders stock. */
export function getCheckoutSlots(): CheckoutSlots {
  return _slots ?? {};
}

/** Test seam. Not for application code. */
export function __resetCheckoutSlotsForTests(): void {
  _slots = undefined;
}
