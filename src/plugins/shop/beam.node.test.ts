import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Structural guard for the Beam adapter's provenance.
 *
 * History: the adapter was twice rewritten from guesses (#135, #151),
 * and the refund body carried a "⚠️ UNVALIDATED" warning (pinned by an
 * earlier version of this file) until Beam's official docs surfaced at
 * https://docs.beamcheckout.com. Every shape is now doc-cited; this
 * test pins those citations so a refactor cannot silently detach the
 * code from its source of truth — the citation is the difference
 * between "documented contract" and "third guess".
 */
const BEAM_SRC = new URL("./beam.ts", import.meta.url).pathname;

describe("Beam adapter doc citations", () => {
  const source = readFileSync(BEAM_SRC, "utf8");

  it("no longer carries the UNVALIDATED refund warning — the shape is documented", () => {
    expect(source).not.toContain("REFUND SHAPE UNVALIDATED");
  });

  it("cites the official refunds reference on the refund method", () => {
    const cite = source.indexOf("docs.beamcheckout.com/refunds/refunds-api");
    const refundAt = source.indexOf("async refund(");
    expect(cite).toBeGreaterThan(-1);
    expect(refundAt).toBeGreaterThan(-1);
  });

  it("cites the official charges reference for the direct QR charge", () => {
    expect(source).toContain("docs.beamcheckout.com/charges/charges-api");
  });

  it("cites the official webhook event list for refund.* events", () => {
    expect(source).toContain("docs.beamcheckout.com/webhook-event-types");
  });
});
