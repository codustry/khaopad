import { describe, expect, it } from "vitest";
import { validateOrderAddress } from "./address-validation";

/**
 * #155 — the structural gate between client-supplied address blobs and
 * the order row. Deliberately market-agnostic: these tests pin the
 * permissive-default contract, not any Thai-specific rules (those
 * belong behind the AddressValidator seam).
 */

const VALID = {
  name: "Somchai Jaidee",
  line1: "99/1 Sukhumvit Rd",
  city: "Bangkok",
  postalCode: "10110",
  countryCode: "TH",
};

describe("validateOrderAddress", () => {
  it("accepts a minimal valid address", () => {
    const result = validateOrderAddress(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.name).toBe("Somchai Jaidee");
      expect(result.address.countryCode).toBe("TH");
      // Optional fields come back as explicit nulls, matching the
      // OrderAddress shape stored in shipping_address_json.
      expect(result.address.line2).toBeNull();
      expect(result.address.phone).toBeNull();
    }
  });

  it("accepts optional fields when present and typed correctly", () => {
    const result = validateOrderAddress({
      ...VALID,
      line2: "Floor 4",
      region: "Bangkok",
      phone: "+66812345678",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.line2).toBe("Floor 4");
      expect(result.address.phone).toBe("+66812345678");
    }
  });

  it("rejects a missing required field, naming it", () => {
    const { city: _city, ...noCity } = VALID;
    const result = validateOrderAddress(noCity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("city");
  });

  it("rejects a wrong-typed required field", () => {
    const result = validateOrderAddress({ ...VALID, postalCode: 10110 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("postalCode");
  });

  it("rejects a wrong-typed optional field", () => {
    const result = validateOrderAddress({ ...VALID, phone: 812345678 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("phone");
  });

  it("rejects whitespace-only required fields", () => {
    const result = validateOrderAddress({ ...VALID, line1: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("line1");
  });

  it("rejects non-objects", () => {
    for (const garbage of [null, undefined, "address", 42, ["TH"], true]) {
      expect(validateOrderAddress(garbage).ok).toBe(false);
    }
  });

  it("rejects extra-field-only garbage", () => {
    const result = validateOrderAddress({ foo: "bar", baz: "qux" });
    expect(result.ok).toBe(false);
  });

  it("trims strings and drops unknown keys", () => {
    const result = validateOrderAddress({
      ...VALID,
      name: "  Somchai  ",
      countryCode: " th ",
      injected: "<script>",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.name).toBe("Somchai");
      // Normalized to uppercase for the zone matcher.
      expect(result.address.countryCode).toBe("TH");
      expect("injected" in result.address).toBe(false);
    }
  });

  it("rejects a countryCode that is not ISO alpha-2", () => {
    for (const bad of ["Thailand", "T", "T1", "123"]) {
      const result = validateOrderAddress({ ...VALID, countryCode: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("countryCode");
    }
  });
});
