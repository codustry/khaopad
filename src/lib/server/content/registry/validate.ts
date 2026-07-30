/**
 * Entry payload validation — Phase 2.
 *
 * The registry is the schema, so it is also the only thing standing
 * between a caller and the entry document. There is no DB constraint to
 * fall back on: `dataJson` will happily store anything. Every value
 * therefore gets checked here, on the way in.
 */
import type { CollectionField, FieldType } from "./schema";
import {
  RegistryError,
  validateFieldConfig,
  type EnumFieldConfig,
  type NumberFieldConfig,
  type TextFieldConfig,
} from "./types";

/** ISO-8601 date (`2026-07-30`). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Pragmatic email check — deliberately not RFC 5322. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Coerce and validate one field value.
 *
 * Returns the value to store. Returns `undefined` for "absent", which
 * the caller omits from the document rather than storing as null — a
 * missing key and an explicit null mean different things when a field is
 * later added to an existing collection.
 */
export function validateFieldValue(
  field: Pick<CollectionField, "apiId" | "type" | "required" | "configJson">,
  raw: unknown,
): unknown {
  const absent = raw === undefined || raw === null || raw === "";
  if (absent) {
    if (field.required) {
      throw new RegistryError(
        `Field "${field.apiId}" is required`,
        "REQUIRED_FIELD_MISSING",
      );
    }
    return undefined;
  }

  const config = validateFieldConfig(
    field.type,
    field.configJson ? safeParse(field.configJson) : {},
  );

  switch (field.type) {
    case "text":
    case "richtext":
    case "slug": {
      const s = expectString(field.apiId, raw);
      checkTextConstraints(field.apiId, s, config as TextFieldConfig);
      return s;
    }

    case "email": {
      const s = expectString(field.apiId, raw);
      checkTextConstraints(field.apiId, s, config as TextFieldConfig);
      if (!EMAIL_RE.test(s)) {
        throw new RegistryError(
          `Field "${field.apiId}" is not a valid email address`,
          "INVALID_VALUE",
        );
      }
      return s;
    }

    case "url": {
      const s = expectString(field.apiId, raw);
      checkTextConstraints(field.apiId, s, config as TextFieldConfig);
      let parsed: URL;
      try {
        parsed = new URL(s);
      } catch {
        throw new RegistryError(
          `Field "${field.apiId}" is not a valid URL`,
          "INVALID_VALUE",
        );
      }
      // Only http(s). A stored `javascript:` or `data:` URL becomes an
      // XSS vector the moment a template renders it into an href.
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new RegistryError(
          `Field "${field.apiId}" must be an http(s) URL (got "${parsed.protocol}")`,
          "INVALID_VALUE",
        );
      }
      return s;
    }

    case "number": {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new RegistryError(
          `Field "${field.apiId}" must be a finite number`,
          "INVALID_VALUE",
        );
      }
      const cfg = config as NumberFieldConfig;
      if (cfg.integer && !Number.isInteger(n)) {
        throw new RegistryError(
          `Field "${field.apiId}" must be an integer`,
          "INVALID_VALUE",
        );
      }
      if (cfg.min !== undefined && n < cfg.min) {
        throw new RegistryError(
          `Field "${field.apiId}" must be >= ${cfg.min}`,
          "INVALID_VALUE",
        );
      }
      if (cfg.max !== undefined && n > cfg.max) {
        throw new RegistryError(
          `Field "${field.apiId}" must be <= ${cfg.max}`,
          "INVALID_VALUE",
        );
      }
      return n;
    }

    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1" || raw === 1) return true;
      if (raw === "false" || raw === "0" || raw === 0) return false;
      throw new RegistryError(
        `Field "${field.apiId}" must be a boolean`,
        "INVALID_VALUE",
      );
    }

    case "date": {
      const s = expectString(field.apiId, raw);
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
        throw new RegistryError(
          `Field "${field.apiId}" must be an ISO date (YYYY-MM-DD)`,
          "INVALID_VALUE",
        );
      }
      return s;
    }

    case "datetime": {
      const s = expectString(field.apiId, raw);
      const t = Date.parse(s);
      if (Number.isNaN(t)) {
        throw new RegistryError(
          `Field "${field.apiId}" must be an ISO datetime`,
          "INVALID_VALUE",
        );
      }
      // Normalize so sorting and range filters compare consistently —
      // "2026-07-30T00:00+07:00" and its UTC equivalent must not sort
      // as different strings.
      return new Date(t).toISOString();
    }

    case "enum": {
      const s = expectString(field.apiId, raw);
      const { options } = config as EnumFieldConfig;
      if (!options.includes(s)) {
        throw new RegistryError(
          `Field "${field.apiId}" must be one of: ${options.join(", ")}`,
          "INVALID_VALUE",
        );
      }
      return s;
    }

    case "json": {
      // Stored as-is, but it must survive a round-trip: a value with a
      // cycle or a BigInt would throw at JSON.stringify time, after
      // other fields had already been written.
      try {
        JSON.parse(JSON.stringify(raw));
      } catch {
        throw new RegistryError(
          `Field "${field.apiId}" must be JSON-serializable`,
          "INVALID_VALUE",
        );
      }
      return raw;
    }

    case "media": {
      // Media ids, not URLs — entries reference media by id and serving
      // stays with the existing /api/media route.
      const ids = Array.isArray(raw) ? raw : [raw];
      for (const id of ids) {
        if (typeof id !== "string" || !id) {
          throw new RegistryError(
            `Field "${field.apiId}" must be a media id (or array of ids)`,
            "INVALID_VALUE",
          );
        }
      }
      return Array.isArray(raw) ? ids : ids[0];
    }

    case "relation":
    case "component":
      // Not stored in the document — these live in entry_relations and
      // are handled by the service, which needs to write edge rows.
      throw new RegistryError(
        `Field "${field.apiId}" is relational and cannot be set as a document value`,
        "INVALID_VALUE",
      );
  }
}

function expectString(apiId: string, raw: unknown): string {
  if (typeof raw !== "string") {
    throw new RegistryError(
      `Field "${apiId}" must be a string`,
      "INVALID_VALUE",
    );
  }
  return raw;
}

function checkTextConstraints(
  apiId: string,
  value: string,
  cfg: TextFieldConfig,
): void {
  if (cfg.minLength !== undefined && value.length < cfg.minLength) {
    throw new RegistryError(
      `Field "${apiId}" must be at least ${cfg.minLength} characters`,
      "INVALID_VALUE",
    );
  }
  if (cfg.maxLength !== undefined && value.length > cfg.maxLength) {
    throw new RegistryError(
      `Field "${apiId}" must be at most ${cfg.maxLength} characters`,
      "INVALID_VALUE",
    );
  }
  if (cfg.pattern !== undefined) {
    // Anchored so a pattern like `[a-z]+` means "the whole value",
    // which is what a schema author intends. An unanchored test would
    // accept "abc!!!" for `^?[a-z]+$?`.
    const anchored = new RegExp(`^(?:${cfg.pattern})$`);
    if (!anchored.test(value)) {
      throw new RegistryError(
        `Field "${apiId}" does not match the required pattern`,
        "INVALID_VALUE",
      );
    }
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Types whose document value is an array. */
export function isMultiValue(type: FieldType, config: unknown): boolean {
  if (type !== "media") return false;
  return (config as { cardinality?: string })?.cardinality === "many";
}
