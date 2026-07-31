import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards the session cookie NAME against issue #120.
 *
 * Better Auth composes the final name as an unconditional concatenation
 * (`cookies/index.mjs`):
 *
 *     name: `${secureCookiePrefix}${name}`
 *
 * with `secureCookiePrefix === "__Secure-"` in production. Configuring a
 * name that already starts with `__Host-` therefore shipped
 * `__Secure-__Host-khaopad_session`.
 *
 * Per RFC 6265bis §4.1.3.2 a prefix only carries its guarantees as the
 * LEADING prefix, so the `__Host-` there was inert — verified against the
 * deployed demo, where a `__Secure-__Host-` cookie was accepted WITH a
 * `Domain` attribute while a correctly-named `__Host-` cookie was refused.
 *
 * This is a structural test rather than a runtime one: instantiating
 * Better Auth needs a D1 binding, and the defect lives in the configured
 * string, which is exactly what this reads.
 */
const AUTH_SRC = new URL("./index.ts", import.meta.url).pathname;

describe("session cookie name (#120)", () => {
  const source = readFileSync(AUTH_SRC, "utf8");

  /** The `name:` value inside the session_token cookie config. */
  const configuredName = (() => {
    const block = source.slice(source.indexOf("session_token:"));
    const match = block.match(/name:\s*"([^"]+)"/);
    return match?.[1];
  })();

  it("configures a session cookie name", () => {
    expect(configuredName).toBeDefined();
  });

  it("does NOT hardcode a __Host- prefix", () => {
    // The regression. Better Auth prepends __Secure- unconditionally, so
    // a __Host- here produces a doubled, inert prefix.
    expect(configuredName).not.toMatch(/^__Host-/);
  });

  it("does NOT hardcode a __Secure- prefix either", () => {
    // Better Auth already adds this in production; hardcoding it would
    // yield __Secure-__Secure- — same class of bug.
    expect(configuredName).not.toMatch(/^__Secure-/);
  });

  it("carries no cookie-prefix at all — the library owns that", () => {
    expect(configuredName).not.toMatch(/^__/);
    expect(configuredName).toBe("khaopad_session");
  });

  it("pins the __Host--equivalent attributes explicitly", () => {
    // We lose browser-enforced __Host- semantics, so these must be set
    // deliberately rather than inherited from a default that could change.
    const block = source.slice(source.indexOf("session_token:"));
    expect(block).toMatch(/path:\s*"\/"/);
    expect(block).toMatch(/httpOnly:\s*true/);
    expect(block).toMatch(/sameSite:\s*"lax"/);
  });

  it("never enables crossSubDomainCookies", () => {
    // Enabling it makes Better Auth set a Domain attribute, which is the
    // one thing __Host- exists to forbid — and would widen session scope
    // to every subdomain.
    expect(source).not.toMatch(
      /crossSubDomainCookies[\s\S]{0,80}enabled:\s*true/,
    );
  });
});
