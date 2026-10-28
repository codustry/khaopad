/**
 * ENGINE_VERSION drift pin.
 *
 * `ENGINE_VERSION` shipped for two releases as a hardcoded `"4.4.0"`
 * literal under a comment that already claimed it was "Sourced from
 * package.json at build time". It was not. When package.json moved to
 * 4.5.0 the constant did not, so every install with telemetry enabled
 * reported a version it was not running — silently, because nothing
 * compared the two.
 *
 * Two tests, because they fail for different reasons and a reader
 * deserves to know which happened:
 *
 * 1. VALUE — the exported constant equals package.json's `version`.
 *    This catches the literal drifting again.
 * 2. SOURCE — the module contains no version-shaped string literal
 *    assigned to ENGINE_VERSION. This catches someone "fixing" a failing
 *    test #1 by retyping the new number, which restores the exact bug.
 *
 * Test #2 is the one that matters. #1 alone is satisfiable by hand.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_VERSION } from "./index";

const pkg = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("ENGINE_VERSION", () => {
  it("equals the version in package.json", () => {
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("is a plain semver string", () => {
    // Telemetry consumers group by this field; a `v` prefix or a stray
    // build suffix would fragment the histogram silently.
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is derived from package.json, not retyped as a literal", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    // The declaration must not assign a quoted version-shaped literal.
    expect(src).not.toMatch(
      /export\s+const\s+ENGINE_VERSION[^\n=]*=\s*["'`]\d+\.\d+\.\d+/,
    );

    // ...and it must actually reach package.json.
    expect(src).toMatch(/package\.json/);
  });
});
