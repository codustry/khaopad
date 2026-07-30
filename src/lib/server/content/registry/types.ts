/**
 * Registry types + per-field-type config contracts — Phase 2 (#68 §B).
 *
 * `collection_fields.configJson` is a different shape per field `type`.
 * These are the shapes, plus the validators that police them, so a
 * malformed field definition is rejected at write time rather than
 * discovered when the admin form fails to render.
 */
import type { FieldType } from "./schema";

/** Cardinality of a `relation` field. */
export type RelationCardinality = "one" | "many";

export interface RelationFieldConfig {
  /** apiId of the target collection. */
  target: string;
  cardinality: RelationCardinality;
  /**
   * Optional inverse name. When set, the target collection can populate
   * back along this edge without declaring its own field.
   */
  inverseOf?: string;
}

export interface ComponentFieldConfig {
  /**
   * apiIds of the `component`-kind collections allowed here. More than
   * one makes this a dynamic zone: an ordered, mixed list of blocks.
   */
  allowed: string[];
  /** A single nested component vs an ordered list. */
  cardinality: RelationCardinality;
}

export interface EnumFieldConfig {
  /** Stored values. Labels are per-locale in the field's labelsJson. */
  options: string[];
}

export interface NumberFieldConfig {
  min?: number;
  max?: number;
  /** Reject non-integers. */
  integer?: boolean;
}

export interface TextFieldConfig {
  minLength?: number;
  maxLength?: number;
  /** Anchored automatically; see `compilePattern`. */
  pattern?: string;
}

export interface MediaFieldConfig {
  cardinality: RelationCardinality;
  /** e.g. ["image/png","image/jpeg"]. Empty/absent = any. */
  mimeTypes?: string[];
}

export type FieldConfig =
  | RelationFieldConfig
  | ComponentFieldConfig
  | EnumFieldConfig
  | NumberFieldConfig
  | TextFieldConfig
  | MediaFieldConfig
  | Record<string, never>;

/** Raised for an invalid registry definition or entry payload. */
export class RegistryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNKNOWN_COLLECTION"
      | "UNKNOWN_FIELD"
      | "DUPLICATE_API_ID"
      | "INVALID_API_ID"
      | "INVALID_FIELD_TYPE"
      | "INVALID_CONFIG"
      | "INVALID_VALUE"
      | "REQUIRED_FIELD_MISSING"
      | "UNIQUE_VIOLATION"
      | "INVALID_LOCALE"
      | "CARDINALITY_VIOLATION"
      | "IMMUTABLE"
      | "SYSTEM_COLLECTION"
      | "PROMOTION_BUDGET_EXCEEDED"
      | "CYCLE_DETECTED",
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Machine names are used as JSON keys, URL segments, and — for promoted
 * fields — SQL identifiers. Restricting them to this shape is what lets
 * `promote.ts` build DDL by interpolation without an injection surface:
 * a name that matches this cannot contain a quote, space, or semicolon.
 *
 * Leading digit excluded so a name is always a valid identifier.
 *
 * **Consecutive underscores are also excluded**, which is what reserves
 * `__` as an unambiguous separator for promoted column names
 * (`q_<collection>__<field>`). Without that reservation, collection
 * `blog_post` + field `title` and collection `blog` + field `post_title`
 * would collide on one column and silently read the wrong JSON path.
 */
export const API_ID_PATTERN = /^[a-z](?:_?[a-z0-9])*$/;

/** Length cap, checked separately so the pattern stays readable. */
const API_ID_MAX_LENGTH = 63;

/**
 * Reserved because they collide with real columns on `entries`, with
 * engine-injected keys, or with SQLite internals. A field named `id`
 * would be shadowed by the row's own id on read.
 */
const RESERVED_API_IDS = new Set([
  "id",
  "collectionid",
  "collection_id",
  "slug",
  "status",
  "publishedat",
  "published_at",
  "datajson",
  "data_json",
  "createdat",
  "created_at",
  "updatedat",
  "updated_at",
  "createdby",
  "created_by",
  "locale",
  "localizations",
  "rowid",
  "oid",
  "_rowid_",
]);

export function assertValidApiId(apiId: string, what: string): void {
  if (!API_ID_PATTERN.test(apiId) || apiId.length > API_ID_MAX_LENGTH) {
    throw new RegistryError(
      `Invalid ${what} "${apiId}" — must be lowercase, start with a letter, ` +
        `contain only letters/digits/single underscores, and be at most ` +
        `${API_ID_MAX_LENGTH} characters`,
      "INVALID_API_ID",
    );
  }
  if (RESERVED_API_IDS.has(apiId.toLowerCase())) {
    throw new RegistryError(
      `"${apiId}" is reserved and cannot be used as a ${what}`,
      "INVALID_API_ID",
    );
  }
}

/**
 * Field types whose values live in `entry_relations` rather than in the
 * entry document. They have no JSON representation at all.
 */
export const RELATIONAL_FIELD_TYPES = new Set<FieldType>([
  "relation",
  "component",
]);

/**
 * Field types that can be promoted to a generated column.
 *
 * Excluded: `json` (no single scalar to extract), and the relational
 * types (not in the document). `richtext` is excluded too — promoting a
 * long body would bloat the index for no filtering benefit; full-text
 * search is FTS5's job, not a generated column's.
 */
export const PROMOTABLE_FIELD_TYPES = new Set<FieldType>([
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "email",
  "url",
  "slug",
  "enum",
]);

/** Which typed column of `entry_field_index` a field's value belongs in. */
export function indexColumnFor(
  type: FieldType,
): "valueText" | "valueNumber" | "valueBool" | null {
  switch (type) {
    case "number":
      return "valueNumber";
    case "boolean":
      return "valueBool";
    case "text":
    case "date":
    case "datetime":
    case "email":
    case "url":
    case "slug":
    case "enum":
      return "valueText";
    // richtext/json are not filterable; relational types aren't in the
    // document at all.
    default:
      return null;
  }
}

/**
 * Validate a field's `configJson` against its type. Returns the parsed
 * config so callers get a typed value rather than re-parsing.
 */
export function validateFieldConfig(
  type: FieldType,
  raw: unknown,
): FieldConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;

  switch (type) {
    case "relation": {
      const target = cfg.target;
      if (typeof target !== "string" || !target) {
        throw new RegistryError(
          "relation field requires config.target (a collection apiId)",
          "INVALID_CONFIG",
        );
      }
      const cardinality = cfg.cardinality ?? "one";
      if (cardinality !== "one" && cardinality !== "many") {
        throw new RegistryError(
          'relation config.cardinality must be "one" or "many"',
          "INVALID_CONFIG",
        );
      }
      if (cfg.inverseOf !== undefined && typeof cfg.inverseOf !== "string") {
        throw new RegistryError(
          "relation config.inverseOf must be a string",
          "INVALID_CONFIG",
        );
      }
      return {
        target,
        cardinality,
        ...(typeof cfg.inverseOf === "string"
          ? { inverseOf: cfg.inverseOf }
          : {}),
      };
    }

    case "component": {
      const allowed = cfg.allowed;
      if (
        !Array.isArray(allowed) ||
        allowed.length === 0 ||
        !allowed.every((a) => typeof a === "string" && a)
      ) {
        throw new RegistryError(
          "component field requires a non-empty config.allowed array of component collection apiIds",
          "INVALID_CONFIG",
        );
      }
      const cardinality = cfg.cardinality ?? "many";
      if (cardinality !== "one" && cardinality !== "many") {
        throw new RegistryError(
          'component config.cardinality must be "one" or "many"',
          "INVALID_CONFIG",
        );
      }
      return { allowed: allowed as string[], cardinality };
    }

    case "enum": {
      const options = cfg.options;
      if (
        !Array.isArray(options) ||
        options.length === 0 ||
        !options.every((o) => typeof o === "string" && o)
      ) {
        throw new RegistryError(
          "enum field requires a non-empty config.options array of strings",
          "INVALID_CONFIG",
        );
      }
      if (new Set(options).size !== options.length) {
        throw new RegistryError(
          "enum config.options contains duplicates",
          "INVALID_CONFIG",
        );
      }
      return { options: options as string[] };
    }

    case "number": {
      const { min, max, integer } = cfg;
      for (const [k, v] of [
        ["min", min],
        ["max", max],
      ] as const) {
        if (v !== undefined && typeof v !== "number") {
          throw new RegistryError(
            `number config.${k} must be a number`,
            "INVALID_CONFIG",
          );
        }
      }
      if (typeof min === "number" && typeof max === "number" && min > max) {
        throw new RegistryError(
          "number config.min cannot exceed config.max",
          "INVALID_CONFIG",
        );
      }
      return {
        ...(typeof min === "number" ? { min } : {}),
        ...(typeof max === "number" ? { max } : {}),
        ...(integer === true ? { integer: true } : {}),
      };
    }

    case "media": {
      const cardinality = cfg.cardinality ?? "one";
      if (cardinality !== "one" && cardinality !== "many") {
        throw new RegistryError(
          'media config.cardinality must be "one" or "many"',
          "INVALID_CONFIG",
        );
      }
      const mimeTypes = cfg.mimeTypes;
      if (
        mimeTypes !== undefined &&
        (!Array.isArray(mimeTypes) ||
          !mimeTypes.every((m) => typeof m === "string"))
      ) {
        throw new RegistryError(
          "media config.mimeTypes must be an array of strings",
          "INVALID_CONFIG",
        );
      }
      return {
        cardinality,
        ...(Array.isArray(mimeTypes)
          ? { mimeTypes: mimeTypes as string[] }
          : {}),
      };
    }

    case "text":
    case "slug":
    case "email":
    case "url": {
      const { minLength, maxLength, pattern } = cfg;
      for (const [k, v] of [
        ["minLength", minLength],
        ["maxLength", maxLength],
      ] as const) {
        if (v !== undefined && (typeof v !== "number" || v < 0)) {
          throw new RegistryError(
            `text config.${k} must be a non-negative number`,
            "INVALID_CONFIG",
          );
        }
      }
      if (pattern !== undefined) {
        if (typeof pattern !== "string") {
          throw new RegistryError(
            "text config.pattern must be a string",
            "INVALID_CONFIG",
          );
        }
        // Reject at definition time rather than letting an unparseable
        // pattern throw on every entry write.
        try {
          new RegExp(pattern);
        } catch {
          throw new RegistryError(
            `text config.pattern is not a valid regular expression: ${pattern}`,
            "INVALID_CONFIG",
          );
        }
      }
      return {
        ...(typeof minLength === "number" ? { minLength } : {}),
        ...(typeof maxLength === "number" ? { maxLength } : {}),
        ...(typeof pattern === "string" ? { pattern } : {}),
      };
    }

    // No configurable options.
    case "richtext":
    case "boolean":
    case "date":
    case "datetime":
    case "json":
      return {};
  }
}
