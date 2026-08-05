import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Structural guards for payment recovery (#157) and in-page PromptPay
 * QR (#156).
 *
 * These are source-level pins, in the same spirit as
 * funnel-locale.node.test.ts and beam.node.test.ts: the properties they
 * protect are security postures and safety comments that no unit test
 * can observe at runtime (a status endpoint that ALSO returned the
 * customer's email would pass any "returns status" test) — so the tests
 * read the source and pin the shape itself.
 */
const R = (p: string) => new URL(p, import.meta.url).pathname;
const read = (p: string) => readFileSync(R(p), "utf8");

/** Comments legitimately NAME the fields they promise not to return —
 * strip them so the forbidden-substring scans only see live code. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const statusSrc = read("./order/[orderNumber]/status/+server.ts");
const paySrc = read("./checkout/pay/+server.ts");
const orderPageSrc = read(
  "../../(www)/[locale]/order/[orderNumber]/+page.svelte",
);
const beamSrc = read("../../../plugins/shop/beam.ts");
const hooksSrc = read("../../../hooks.server.ts");

describe("status endpoint returns THE STATUS ALONE (#157)", () => {
  it("selects only the status column", () => {
    // A minimal column select means no refactor can accidentally start
    // leaking order details through this unauthenticated endpoint.
    expect(statusSrc).toMatch(
      /select\(\{\s*status:\s*shopOrders\.status\s*\}\)/,
    );
  });

  it("never touches items, email, addresses, or totals", () => {
    // An order number is a weak secret; the status string is the whole
    // disclosure budget.
    const code = stripComments(statusSrc);
    for (const forbidden of [
      "email",
      "Items",
      "items",
      "Address",
      "totalSatang",
      "OrderService",
      "hydrate",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("404s with a bare { ok: false }", () => {
    expect(statusSrc).toMatch(/json\(\{ ok: false \}, \{ status: 404 \}\)/);
  });

  it("relies on the documented /api/* no-store catch-all", () => {
    // The route deliberately sets no Cache-Control of its own — the
    // cacheHook's /api/* branch already forces no-store. Pin both the
    // comment documenting the reliance and the hook branch it relies on.
    expect(statusSrc).toContain("no-store");
    expect(statusSrc).toMatch(/cacheHook|hooks\.server\.ts/);
    expect(hooksSrc).toMatch(
      /path\.startsWith\("\/api\/"\)[\s\S]{0,200}?value = "no-store"/,
    );
  });
});

describe("pay-by-orderNumber (#157)", () => {
  it("accepts orderNumber as an alternative to orderId", () => {
    expect(paySrc).toContain("getOrderByNumber");
    expect(paySrc).toMatch(/!body\?\.orderId && !body\?\.orderNumber/);
  });

  it("refuses any order not in pending status", () => {
    // The guard sits BEFORE any charge creation — a paid/cancelled/
    // refunded order can never mint a fresh payment link.
    const guardAt = paySrc.indexOf('order.status !== "pending"');
    const chargeAt = paySrc.indexOf("createCharge(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(chargeAt).toBeGreaterThan(guardAt);
    expect(paySrc).toContain("ORDER_NOT_PENDING");
  });

  it("documents the accepted weak-secret risk", () => {
    expect(paySrc).toContain("ACCEPTED RISK");
    expect(paySrc).toContain("worst case");
  });

  it("responses stay minimal — no items, email, or address fields", () => {
    // The json() responses may carry the payment URL / QR and charge id,
    // nothing else about the order.
    for (const forbidden of [
      "items:",
      "email:",
      "shippingAddress",
      "billingAddress",
      "totalSatang:",
    ]) {
      expect(paySrc, forbidden).not.toContain(forbidden);
    }
  });

  it("builds a localized return URL with the ?payment=returned hint", () => {
    // Locale comes from the Paraglide cookie (API routes have no locale
    // param) — fixes the Thai-customer-lands-on-English-page bug.
    expect(paySrc).toContain("cookieName");
    expect(paySrc).toContain("localePath");
    expect(paySrc).toContain("?payment=returned");
  });

  it("falls back to the hosted link on any QR failure", () => {
    // Duck-typed QR (#156): method requested AND provider implements it;
    // the hosted-link call must remain reachable below the QR attempt.
    const duckAt = paySrc.indexOf(
      'typeof provider.createQrCharge === "function"',
    );
    const fallbackAt = paySrc.lastIndexOf("provider.createCharge(");
    expect(duckAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(duckAt);
    // And a thrown QR error is swallowed, not surfaced.
    expect(paySrc).toMatch(/catch[\s\S]{0,400}falling back to hosted link/);
  });
});

describe("order page arrival states (#157)", () => {
  it("polls ONLY under ?payment=returned", () => {
    expect(orderPageSrc).toMatch(
      /paymentHint !== 'returned'\) return|paymentHint === 'returned'/,
    );
    expect(orderPageSrc).toContain("/status");
  });

  it("pins the hint-not-authority comment", () => {
    // ?payment= must never write payment state — only the webhook does.
    expect(orderPageSrc).toContain("UI HINT ONLY");
    expect(orderPageSrc).toMatch(/[Oo]nly the .*webhook/);
  });

  it("retry button POSTs the orderNumber to /checkout/pay", () => {
    expect(orderPageSrc).toContain("'/api/shop/checkout/pay'");
    expect(orderPageSrc).toContain(
      "JSON.stringify({ orderNumber: order.orderNumber })",
    );
  });

  it("polling caps out and falls back to pending + retry", () => {
    expect(orderPageSrc).toContain("POLL_MAX_MS");
    expect(orderPageSrc).toContain("pollTimedOut");
  });
});

describe("Beam QR request-shape flag (#156)", () => {
  it("keeps the UNVALIDATED REQUEST SHAPE warning on the QR body", () => {
    // Same policy as the refund() warning pinned in beam.node.test.ts:
    // the request body mirrors the (validated) response naming but was
    // never observed on the wire — the warning must survive until the
    // real shape is captured.
    expect(beamSrc).toContain("UNVALIDATED REQUEST SHAPE");
    const warnAt = beamSrc.indexOf("UNVALIDATED REQUEST SHAPE");
    const methodAt = beamSrc.indexOf("paymentMethodType");
    expect(methodAt).toBeGreaterThan(warnAt);
  });

  it("keeps QR failure non-fatal in the adapter", () => {
    // The docblock's NEVER-throws contract must sit directly above the
    // method it governs.
    const warnAt = beamSrc.indexOf("NEVER throws");
    const methodAt = beamSrc.indexOf("async createQrCharge(");
    expect(warnAt).toBeGreaterThan(-1);
    expect(methodAt).toBeGreaterThan(warnAt);
    expect(methodAt - warnAt).toBeLessThan(1500);
  });
});
