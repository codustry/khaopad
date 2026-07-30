import { describe, expect, it } from "vitest";
import { FIELD_TYPES } from "$lib/server/content/registry/schema";
import {
  FIELD_EDITORS,
  fieldName,
  isRelational,
  parseFieldName,
} from "./field-map";

/**
 * The registry-driven editor (Phase 4) encodes every field into one
 * namespaced FormData key, and the save action parses them back. If that
 * encoding is lossy or ambiguous, edits are silently dropped — the worst
 * failure mode for a CMS, because the UI reports success.
 *
 * Previously verified by a throwaway script; kept here so it stays true.
 */

describe("editor coverage", () => {
  it("maps every field type to an editor", () => {
    // FIELD_EDITORS is typed Record<FieldType, …> so a missing entry is a
    // compile error — but the type only guards the keys, not that the
    // runtime object was fully populated (e.g. after a bad merge).
    for (const type of FIELD_TYPES) {
      expect(FIELD_EDITORS[type], `no editor for "${type}"`).toBeDefined();
      expect(FIELD_EDITORS[type].editor).toBeTypeOf("string");
    }
  });

  it("marks exactly the relational types as relational", () => {
    // These post ids into entry_relations rather than scalars into the
    // document; treating one as the other writes to the wrong table.
    const relational = FIELD_TYPES.filter((t) => isRelational(t));
    expect(relational.sort()).toEqual(["component", "relation"]);
  });
});

describe("form-name round-trip", () => {
  it("round-trips a non-localized document field", () => {
    expect(parseFieldName(fieldName("text", "sku"))).toEqual({
      kind: "doc",
      apiId: "sku",
    });
  });

  it("round-trips a localized field", () => {
    expect(parseFieldName(fieldName("text", "title", "en"))).toEqual({
      kind: "localized",
      locale: "en",
      apiId: "title",
    });
  });

  it("round-trips a relation field", () => {
    expect(parseFieldName(fieldName("relation", "variants"))).toEqual({
      kind: "relation",
      apiId: "variants",
    });
  });

  it("ignores locale for relational fields", () => {
    // Relations live in entry_relations, which has no locale column —
    // namespacing one in would produce a key the parser routes to the
    // wrong branch.
    expect(fieldName("relation", "variants", "en")).toBe("r.variants");
  });

  it("survives an apiId containing underscores", () => {
    // `l.<locale>.<apiId>` splits on the FIRST dot after the prefix.
    // apiIds cannot contain dots (API_ID_PATTERN) but very much can
    // contain underscores, so this is the realistic edge case.
    expect(parseFieldName("l.th.motor_power")).toEqual({
      kind: "localized",
      locale: "th",
      apiId: "motor_power",
    });
  });

  it("round-trips every field type at least once", () => {
    for (const type of FIELD_TYPES) {
      const parsed = parseFieldName(fieldName(type, "some_field"));
      expect(parsed, `round-trip failed for "${type}"`).not.toBeNull();
      expect(parsed?.apiId).toBe("some_field");
    }
  });
});

describe("malformed keys", () => {
  it("rejects rather than mis-parsing", () => {
    // Returning a plausible-but-wrong parse is worse than null: the save
    // action would write the value under the wrong field.
    for (const bad of [
      "x.foo", // unknown namespace
      "f.", // empty apiId
      "r.", // empty apiId
      "l.", // no locale, no apiId
      "l.en", // locale but no apiId
      "l..title", // empty locale
      "", // empty
      "slug", // an unnamespaced form field
      "status",
    ]) {
      expect(
        parseFieldName(bad),
        `accepted malformed key ${JSON.stringify(bad)}`,
      ).toBeNull();
    }
  });
});
