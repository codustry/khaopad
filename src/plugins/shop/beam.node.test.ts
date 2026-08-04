import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards #151 point 4: the Beam REFUND body shape was never validated
 * against real Beam. Unlike the charge and webhook shapes (validated
 * against two production integrations), the refund call still carries
 * the original guessed snake_case body — deliberately unchanged,
 * because replacing one guess with another guess helps nobody.
 *
 * This structural test pins the warning block in beam.ts so it cannot
 * silently vanish in a refactor before someone captures the real shape.
 * When the refund contract IS validated: fix the body, delete the
 * warning, and update this test to pin the validated shape instead.
 */
const BEAM_SRC = new URL("./beam.ts", import.meta.url).pathname;

describe("Beam refund shape flag (#151 point 4)", () => {
  const source = readFileSync(BEAM_SRC, "utf8");

  it("keeps the UNVALIDATED warning on the refund method", () => {
    expect(source).toContain("REFUND SHAPE UNVALIDATED AGAINST REAL BEAM");
    expect(source).toContain("#151 point 4");
  });

  it("keeps the warning attached to the refund implementation", () => {
    // The warning must sit ABOVE the refund method, not drift elsewhere.
    const warningAt = source.indexOf("REFUND SHAPE UNVALIDATED");
    const refundAt = source.indexOf("async refund(");
    expect(warningAt).toBeGreaterThan(-1);
    expect(refundAt).toBeGreaterThan(warningAt);
  });
});
