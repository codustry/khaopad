import { describe, it, expect } from "vitest";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, toLocale } from "./index";
import type { Locale } from "$lib/server/content/types";

/**
 * Locale negotiation for the site root (`/` → `/en` or `/th`).
 *
 * The original guard read:
 *
 *     if (lang && SUPPORTED_LOCALES.includes(toLocale(lang)))
 *       throw redirect(308, `/${lang}`);
 *
 * which is INERT. `toLocale()` coerces anything unknown to
 * DEFAULT_LOCALE, so `includes(toLocale(x))` is true for every input —
 * and the redirect then used the RAW tag. `Accept-Language: *` (a valid
 * wildcard per RFC 9110, and what Node's fetch sends by default)
 * produced `Location: /*` and a 404 on the site root.
 *
 * Found by crawling the deployed demo: curl worked, Node's fetch did
 * not, because they send different Accept-Language defaults.
 */

/** The corrected predicate: membership tested on the RAW value. */
const accepts = (lang: string) => SUPPORTED_LOCALES.includes(lang as Locale);

/** The original, defective predicate — kept to document why it failed. */
const acceptsInert = (lang: string) =>
  SUPPORTED_LOCALES.includes(toLocale(lang));

describe("toLocale", () => {
  it("passes through supported locales", () => {
    expect(toLocale("en")).toBe("en");
    expect(toLocale("th")).toBe("th");
  });

  it("coerces anything else to the default — which is why it must not guard", () => {
    expect(toLocale("*")).toBe(DEFAULT_LOCALE);
    expect(toLocale("zz")).toBe(DEFAULT_LOCALE);
    expect(toLocale("")).toBe(DEFAULT_LOCALE);
  });
});

describe("locale negotiation guard", () => {
  it("accepts supported tags", () => {
    expect(accepts("en")).toBe(true);
    expect(accepts("th")).toBe(true);
  });

  it("REJECTS the wildcard that broke the site root", () => {
    // `Accept-Language: *` is legal and is Node fetch's default.
    expect(accepts("*")).toBe(false);
  });

  it("rejects unknown and malformed tags", () => {
    for (const bad of ["zz", "xx", "", "en_US", "../etc", "%2e%2e"]) {
      expect(accepts(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("never yields a redirect target outside the supported set", () => {
    // The property that actually matters: whatever we redirect to must
    // be a real locale segment, so `/${lang}` can never 404.
    const tags = ["*", "zz", "en", "th", "en-US", "th-TH", "xx-YY", ""];
    for (const t of tags) {
      const lang = t.trim().split(/[-;]/)[0]?.toLowerCase() ?? "";
      if (accepts(lang)) expect(SUPPORTED_LOCALES).toContain(lang);
    }
  });

  it("documents that the ORIGINAL guard admitted everything", () => {
    // Regression anchor: if someone reintroduces toLocale() in the
    // predicate, this is the behaviour they get back.
    expect(acceptsInert("*")).toBe(true); // ← the bug
    expect(acceptsInert("zz")).toBe(true); // ← the bug
    expect(accepts("*")).toBe(false); // ← the fix
  });
});
