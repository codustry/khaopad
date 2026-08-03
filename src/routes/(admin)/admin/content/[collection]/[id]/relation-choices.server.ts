/**
 * Relation pick-list assembly for the registry entry editor (#126).
 *
 * Extracted from the loader so the one property that prevents data loss
 * is unit-testable: the choices for a field must ALWAYS contain the
 * entry's currently-selected targets. The picker posts the full desired
 * id list on save, so a selected target missing from the choice window
 * would silently vanish from the entry on the next save.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, asc, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  entries,
  entryLocalizations,
} from "$lib/server/content/registry/schema";
import type {
  CollectionField,
  Collection,
} from "$lib/server/content/registry/schema";

/** D1 binds at most 100 parameters per statement. */
const CHUNK = 90;

export interface RelationChoice {
  id: string;
  label: string;
}

export interface CollectionWithFieldsLike extends Collection {
  fields: CollectionField[];
}

export interface RelationChoicesResult {
  /** Per relation field: choices to offer, selected targets included. */
  choices: Record<string, RelationChoice[]>;
  /**
   * Per relation field: how many entries MATCH (the query, if any) in
   * total — lets the UI say "showing N of M" when the window truncates.
   */
  totals: Record<string, number>;
}

interface Options {
  /** The owning collection's fields; non-relational ones are ignored. */
  fields: CollectionField[];
  /** Every collection with fields, for target resolution + labels. */
  targetCollections: CollectionWithFieldsLike[];
  /** Currently-selected targets per field (ids and `ns:ref` strings). */
  selected: Record<string, string[]>;
  defaultLocale: string;
  /** Search term from `?relationQuery=`; empty means no filter. */
  query: string;
  limit: number;
}

export async function buildRelationChoices(
  db: ReturnType<typeof drizzle>,
  opts: Options,
): Promise<RelationChoicesResult> {
  const choices: Record<string, RelationChoice[]> = {};
  const totals: Record<string, number> = {};

  // Which collections each relation field may point at.
  const allowedByField = new Map<string, string[]>();
  const targetApiIds = new Set<string>();
  for (const field of opts.fields) {
    if (field.type !== "relation" && field.type !== "component") continue;
    const cfg = safeParse(field.configJson ?? "{}");
    const allowed =
      typeof cfg.target === "string"
        ? [cfg.target]
        : Array.isArray(cfg.allowed)
          ? (cfg.allowed as unknown[]).filter(
              (a): a is string => typeof a === "string",
            )
          : [];
    allowedByField.set(field.apiId, allowed);
    for (const a of allowed) targetApiIds.add(a);
    choices[field.apiId] = [];
    totals[field.apiId] = 0;
  }
  if (allowedByField.size === 0) return { choices, totals };

  const wanted = opts.targetCollections.filter((c) =>
    targetApiIds.has(c.apiId),
  );
  // The display-name field per target collection: the first text field
  // named name/title, in declared order. Registry fields arrive sorted
  // by position already (getCollection orders them), so [0] is "first".
  const nameFieldByCollection = new Map<string, CollectionField>();
  for (const c of wanted) {
    const nameField = c.fields.find(
      (f) => f.type === "text" && (f.apiId === "name" || f.apiId === "title"),
    );
    if (nameField) nameFieldByCollection.set(c.id, nameField);
  }

  const wantedIds = wanted.map((c) => c.id);
  let windowRows: WindowRow[] = [];
  const countByCollection = new Map<string, number>();

  if (wantedIds.length > 0) {
    const conditions: SQL[] = [inArray(entries.collectionId, wantedIds)];
    const q = opts.query.trim();
    if (q) {
      // Escape LIKE metacharacters so a literal "%" in a slug can be
      // searched for rather than matching everything.
      const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      // Match slug, the entry document, or any localization document.
      // Substring-over-JSON is crude but findable is the requirement:
      // the window caps at `limit`, and anything beyond it is unreachable
      // without a server-side filter.
      conditions.push(
        or(
          sql`${entries.slug} LIKE ${pattern} ESCAPE '\\'`,
          sql`${entries.dataJson} LIKE ${pattern} ESCAPE '\\'`,
          sql`EXISTS (SELECT 1 FROM ${entryLocalizations} WHERE ${entryLocalizations.entryId} = ${entries.id} AND ${entryLocalizations.dataJson} LIKE ${pattern} ESCAPE '\\')`,
        )!,
      );
    }
    const where = and(...conditions);

    windowRows = await db
      .select({
        id: entries.id,
        slug: entries.slug,
        collectionId: entries.collectionId,
        dataJson: entries.dataJson,
      })
      .from(entries)
      .where(where)
      .orderBy(asc(entries.slug), asc(entries.id))
      .limit(opts.limit)
      .all();

    // Counts per target collection under the SAME filter, so "showing
    // N of M" reflects what typing more would actually surface.
    const counts = await db
      .select({
        collectionId: entries.collectionId,
        n: sql<number>`count(*)`,
      })
      .from(entries)
      .where(where)
      .groupBy(entries.collectionId)
      .all();
    for (const row of counts) countByCollection.set(row.collectionId, row.n);
  }

  // THE data-loss fix: fetch currently-selected targets by id, whether
  // or not the window (or the search filter) happened to include them.
  const selectedEntryIds = new Set<string>();
  for (const [fieldApiId, ids] of Object.entries(opts.selected)) {
    if (!allowedByField.has(fieldApiId)) continue;
    // `ns:ref` strings are external references, not entry ids (#99).
    for (const id of ids) if (!id.includes(":")) selectedEntryIds.add(id);
  }
  const inWindow = new Set(windowRows.map((r) => r.id));
  const missing = [...selectedEntryIds].filter((id) => !inWindow.has(id));
  const selectedRows =
    missing.length === 0
      ? []
      : await loadChunked(missing, (chunk) =>
          db
            .select({
              id: entries.id,
              slug: entries.slug,
              collectionId: entries.collectionId,
              dataJson: entries.dataJson,
            })
            .from(entries)
            .where(inArray(entries.id, chunk))
            .all(),
        );

  const allRows = [...windowRows, ...selectedRows];
  const rowById = new Map(allRows.map((r) => [r.id, r]));

  // Localized display names, one query for every row that needs one.
  const needsLocalized = allRows.filter((r) => {
    const nf = nameFieldByCollection.get(r.collectionId);
    return nf?.localized === true;
  });
  const localizedDocById = new Map<string, Record<string, unknown>>();
  if (needsLocalized.length > 0) {
    const locRows = await loadChunked(
      needsLocalized.map((r) => r.id),
      (chunk) =>
        db
          .select({
            entryId: entryLocalizations.entryId,
            locale: entryLocalizations.locale,
            dataJson: entryLocalizations.dataJson,
          })
          .from(entryLocalizations)
          .where(inArray(entryLocalizations.entryId, chunk))
          .all(),
    );
    for (const row of locRows) {
      if (row.locale !== opts.defaultLocale) continue;
      localizedDocById.set(row.entryId, safeParse(row.dataJson));
    }
  }

  const labelOf = (row: WindowRow): string => {
    const nf = nameFieldByCollection.get(row.collectionId);
    let name: string | null = null;
    if (nf) {
      const doc = nf.localized
        ? (localizedDocById.get(row.id) ?? {})
        : safeParse(row.dataJson);
      const raw = doc[nf.apiId];
      if (typeof raw === "string" && raw.trim()) name = raw.trim();
    }
    if (name && row.slug) return `${name} (${row.slug})`;
    return name ?? row.slug ?? row.id;
  };

  const apiIdByCollectionId = new Map(wanted.map((c) => [c.id, c.apiId]));
  for (const [fieldApiId, allowedApiIds] of allowedByField.entries()) {
    const allowedSet = new Set(allowedApiIds);
    const allowedCollectionIds = wanted
      .filter((c) => allowedSet.has(c.apiId))
      .map((c) => c.id);

    const fieldChoices: RelationChoice[] = windowRows
      .filter((r) =>
        allowedSet.has(apiIdByCollectionId.get(r.collectionId) ?? ""),
      )
      .map((r) => ({ id: r.id, label: labelOf(r) }));
    const present = new Set(fieldChoices.map((c) => c.id));

    // Selected targets are appended UNCONDITIONALLY — even one whose
    // collection is no longer allowed by the field config. Dropping it
    // from the choices would delete the edge on the next save; keeping
    // it visible lets the editor decide.
    for (const id of opts.selected[fieldApiId] ?? []) {
      if (present.has(id)) continue;
      present.add(id);
      const row = rowById.get(id);
      fieldChoices.push(
        row
          ? { id, label: labelOf(row) }
          : // External `ns:ref` targets (and ids that no longer resolve)
            // round-trip verbatim so saving never silently drops them.
            { id, label: id },
      );
    }

    let total = 0;
    for (const cid of allowedCollectionIds) {
      total += countByCollection.get(cid) ?? 0;
    }
    choices[fieldApiId] = fieldChoices;
    totals[fieldApiId] = total;
  }

  return { choices, totals };
}

interface WindowRow {
  id: string;
  slug: string | null;
  collectionId: string;
  dataJson: string;
}

async function loadChunked<T>(
  ids: string[],
  load: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  if (ids.length <= CHUNK) return load(ids);
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...(await load(ids.slice(i, i + CHUNK))));
  }
  return out;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
