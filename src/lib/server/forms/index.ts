/**
 * Helpers for form submission validation + rate limiting (v2.0a).
 */
import type { FormField, FormRecord } from "$lib/server/content/types";
import {
  HONEYPOT_FIELD,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_SECONDS,
} from "$lib/forms/constants";

// Re-exported for compatibility with existing server-side imports.
// The constants themselves live in `$lib/forms/constants` so client
// components (e.g. v2.0c CommentSection) can use the honeypot name
// without pulling a server-only module into the client bundle.
export { HONEYPOT_FIELD, RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_SECONDS };

/**
 * Hash an IP address with SHA-256 + truncate to 16 hex chars. We never
 * store the raw IP — only the hash, used as a coarse cluster key for
 * rate limiting + spam detection.
 */
export async function hashIp(ip: string): Promise<string> {
  const enc = new TextEncoder().encode(ip);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Validate the submitted payload against the form's field definitions.
 * Returns the cleaned data (only known fields, trimmed strings) or an
 * error message describing the first failure.
 */
export function validateSubmission(
  form: FormRecord,
  payload: Record<string, FormDataEntryValue>,
): { ok: true; data: Record<string, string> } | { ok: false; error: string } {
  // Honeypot. A real visitor's browser leaves the hidden input empty;
  // most spam bots fill every input. Reject (silently 200) when set.
  const hp = payload[HONEYPOT_FIELD];
  if (typeof hp === "string" && hp.trim() !== "") {
    return { ok: false, error: "Honeypot tripped." };
  }

  const data: Record<string, string> = {};
  for (const field of form.fields) {
    const raw = payload[field.name];
    const value = typeof raw === "string" ? raw.trim() : "";

    if (field.kind === "checkbox") {
      // Browsers omit unchecked checkboxes from form data; treat that
      // as "off". Required-checkbox is the GDPR consent pattern.
      const checked = value !== "" && value !== "off";
      if (field.required && !checked) {
        return {
          ok: false,
          error: `Field "${field.label}" is required.`,
        };
      }
      data[field.name] = checked ? "on" : "";
      continue;
    }

    if (field.required && !value) {
      return { ok: false, error: `Field "${field.label}" is required.` };
    }

    if (field.kind === "email" && value) {
      // Cheap validity check; we deliberately don't run a full RFC
      // parser. Stops obviously-bad submissions; real validation is
      // the editor's job.
      if (!/.+@.+\..+/.test(value)) {
        return { ok: false, error: `"${field.label}" is not a valid email.` };
      }
    }

    const max =
      "maxLength" in field && typeof field.maxLength === "number"
        ? field.maxLength
        : 5000;
    if (value.length > max) {
      return {
        ok: false,
        error: `"${field.label}" exceeds maximum length of ${max} chars.`,
      };
    }

    data[field.name] = value;
  }

  return { ok: true, data };
}

/** Stable JSON re-serialization for FormField[]. */
export function isValidFieldList(value: unknown): value is FormField[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    if (typeof (item as FormField).name !== "string") return false;
    if (typeof (item as FormField).label !== "string") return false;
    if (
      !["text", "email", "textarea", "checkbox"].includes(
        (item as FormField).kind,
      )
    ) {
      return false;
    }
  }
  return true;
}
