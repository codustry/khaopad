/**
 * Field-type → editor-component map — Phase 4 (#68 §F).
 *
 * The registry stores what a field IS; this decides how to edit it. One
 * table replaces the per-type hand-built forms (`ArticleForm.svelte`,
 * `PageForm.svelte`), which is the whole point: adding a content type
 * should not mean writing a form.
 *
 * Deliberately data, not a `{#if type === …}` chain in the template —
 * a new field type is one entry here plus one component, and the
 * exhaustiveness check below makes a missing entry a compile error
 * rather than a silently unrendered field.
 */
import type { FieldType } from "$lib/server/content/registry/schema";

/** Which input primitive renders a field. */
export type EditorKind =
  | "text"
  | "textarea"
  | "richtext"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "select"
  | "json"
  | "media"
  | "relation"
  | "component";

export interface FieldRenderSpec {
  editor: EditorKind;
  /** `type` attribute for plain <input> editors. */
  inputType?: "text" | "number" | "email" | "url" | "date" | "datetime-local";
  /**
   * True when the value lives in `entry_relations` rather than the
   * entry document — the form posts ids, not scalars.
   */
  relational?: boolean;
  /** Shown under the input when the field has no description. */
  hint?: string;
}

/**
 * Exhaustive by construction: `Record<FieldType, …>` means adding a
 * `FieldType` without adding it here fails the type-check. That matters
 * because the fallback for an unmapped field would be to render nothing,
 * i.e. silently drop editable content.
 */
export const FIELD_EDITORS: Record<FieldType, FieldRenderSpec> = {
  text: { editor: "text", inputType: "text" },
  richtext: {
    editor: "richtext",
    hint: "Markdown. Supports the same {{block:key}} shortcodes as articles.",
  },
  number: { editor: "number", inputType: "number" },
  boolean: { editor: "checkbox" },
  date: { editor: "date", inputType: "date" },
  datetime: { editor: "datetime", inputType: "datetime-local" },
  email: { editor: "text", inputType: "email" },
  url: { editor: "text", inputType: "url", hint: "Must be http(s)." },
  slug: {
    editor: "text",
    inputType: "text",
    hint: "Lowercase ASCII, hyphens. Shared across locales.",
  },
  enum: { editor: "select" },
  json: {
    editor: "json",
    hint: "Raw JSON. Validated on save.",
  },
  media: { editor: "media", relational: false },
  relation: { editor: "relation", relational: true },
  component: { editor: "component", relational: true },
};

/** Field types whose values are posted as ids, not document scalars. */
export function isRelational(type: FieldType): boolean {
  return FIELD_EDITORS[type].relational === true;
}

/**
 * Form field name for a field, namespaced so the action can tell
 * document values, per-locale values and relations apart in one
 * FormData.
 *
 *   f.sku            non-localized document value
 *   l.en.title       localized document value
 *   r.variants       relation edge list (comma-separated ids)
 */
export function fieldName(
  type: FieldType,
  apiId: string,
  locale?: string,
): string {
  if (isRelational(type)) return `r.${apiId}`;
  return locale ? `l.${locale}.${apiId}` : `f.${apiId}`;
}

/** Parse a namespaced form key back into its parts. */
export function parseFieldName(
  key: string,
):
  | { kind: "doc"; apiId: string }
  | { kind: "localized"; locale: string; apiId: string }
  | { kind: "relation"; apiId: string }
  | null {
  if (key.startsWith("f.")) {
    const apiId = key.slice(2);
    return apiId ? { kind: "doc", apiId } : null;
  }
  if (key.startsWith("r.")) {
    const apiId = key.slice(2);
    return apiId ? { kind: "relation", apiId } : null;
  }
  if (key.startsWith("l.")) {
    // `l.<locale>.<apiId>` — apiIds can't contain dots (API_ID_PATTERN),
    // so splitting on the FIRST dot after the prefix is unambiguous.
    const rest = key.slice(2);
    const dot = rest.indexOf(".");
    if (dot <= 0) return null;
    const locale = rest.slice(0, dot);
    const apiId = rest.slice(dot + 1);
    return locale && apiId ? { kind: "localized", locale, apiId } : null;
  }
  return null;
}

/** Human label for a field, falling back to its machine key. */
export function labelFor(
  labelsJson: string | null,
  apiId: string,
  locale: string,
): string {
  if (!labelsJson) return apiId;
  try {
    const parsed = JSON.parse(labelsJson) as Record<string, unknown>;
    const hit = parsed[locale] ?? parsed.en;
    return typeof hit === "string" && hit ? hit : apiId;
  } catch {
    return apiId;
  }
}
