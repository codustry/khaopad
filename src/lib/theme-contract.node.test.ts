import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_CONTRACT_VERSION } from "./theme-contract";

/**
 * #174 Step 7 — the contract's three artifacts must agree.
 *
 * The guard script enforces the surface floor in CI; these pins enforce the
 * thing the guard can't: that the version constant, the baseline, and the
 * human-readable doc all name the SAME version, so none of them can drift
 * into quietly documenting a contract that no longer exists.
 */
const root = process.cwd();

describe("theme contract version coherence", () => {
  it("is strict semver", () => {
    expect(THEME_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the guard baseline", () => {
    const baseline = JSON.parse(
      readFileSync(join(root, "theme-contract.baseline.json"), "utf8"),
    );
    expect(baseline.contractVersion).toBe(THEME_CONTRACT_VERSION);
  });

  it("matches docs/THEME-CONTRACT.md", () => {
    const doc = readFileSync(join(root, "docs/THEME-CONTRACT.md"), "utf8");
    expect(doc).toContain(`**Version: ${THEME_CONTRACT_VERSION}**`);
  });

  it("baseline pins every documented surface group", () => {
    const baseline = JSON.parse(
      readFileSync(join(root, "theme-contract.baseline.json"), "utf8"),
    );
    for (const group of [
      "chromeSlots",
      "siteHeaderProps",
      "siteFooterProps",
      "homePageProps",
      "checkoutSlots",
      "checkoutSlotProps",
      "billingAddressFields",
      "shopComponents",
      "wwwComponents",
      "messageKeys",
    ]) {
      expect(baseline[group], group).toBeInstanceOf(Array);
      expect(baseline[group].length, group).toBeGreaterThan(0);
    }
  });

  it("CI actually runs the guard", () => {
    // A guard that exists but isn't wired is the silent-seam failure mode
    // all over again (#174 Step 2).
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("pnpm run guard:contract");
  });
});
