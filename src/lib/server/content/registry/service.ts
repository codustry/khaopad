/**
 * Registry service — Phase 2 (#68 §B/§C/§F).
 *
 * The write API for both halves of the design:
 *
 *  - **Schema as data** — create/alter collections and fields. No
 *    migration, no deploy. This is the core DX win the phase exists for.
 *  - **Entries** — create/update entries, their per-locale documents,
 *    and their relation edges.
 *
 * It is also the source-agnostic import surface the task calls for: a
 * Strapi export, a CSV, or a JSON dump all land through these same
 * methods, so an importer is a thin script rather than part of the
 * engine.
 *
 * ## Where the invariants live
 *
 * There is no DB constraint on a value inside a JSON document, so the
 * service is the only enforcement point for required fields, types,
 * enums, uniqueness and relation cardinality. Nothing may write
 * `entries.dataJson` except through here.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { slugify } from "$lib/utils";
import { listCollectionIds as listBuiltinCollectionIds } from "../query/registry";
import {
  collectionFields,
  collections,
  entries,
  entryFieldIndex,
  entryLocalizations,
  entryRelations,
  entryVersions,
  type Collection,
  type CollectionField,
  type Entry,
  type FieldType,
} from "./schema";
import {
  assertValidApiId,
  indexColumnFor,
  RegistryError,
  RELATIONAL_FIELD_TYPES,
  validateFieldConfig,
  type ComponentFieldConfig,
  type RelationFieldConfig,
} from "./types";
import { validateFieldValue } from "./validate";
import { PromotionService, type PromotionTarget } from "./promote";

/** D1 binds at most 100 parameters per statement. */
const D1_MAX_BIND_PARAMS = 100;

/**
 * apiIds owned by the code-defined query registry. Imported rather than
 * hardcoded so adding a built-in collection automatically reserves its
 * name here.
 */
const BUILTIN_COLLECTION_API_IDS = new Set(listBuiltinCollectionIds());

export interface CollectionWithFields extends Collection {
  fields: CollectionField[];
}

export interface CreateCollectionInput {
  apiId: string;
  kind?: "collection" | "single" | "component";
  labels?: Record<string, { singular: string; plural: string }>;
  draftPublish?: boolean;
  localized?: boolean;
  description?: string;
  createdBy?: string;
}

export interface CreateFieldInput {
  apiId: string;
  type: FieldType;
  labels?: Record<string, string>;
  required?: boolean;
  localized?: boolean;
  unique?: boolean;
  promoted?: boolean;
  config?: unknown;
  position?: number;
}

export interface UpsertEntryInput {
  /** Omit to create. */
  id?: string;
  slug?: string;
  status?: "draft" | "published" | "archived";
  publishedAt?: string | null;
  /** Non-localized field values, keyed by field apiId. */
  data?: Record<string, unknown>;
  /** Localized values: `{ en: {...}, th: {...} }`. */
  localizations?: Record<string, Record<string, unknown>>;
  /**
   * Relation + component edges, keyed by field apiId. Order is
   * significant and is persisted as `position`.
   */
  relations?: Record<string, string[]>;
  /**
   * Edge attributes (#99), keyed by field apiId then by target string:
   * `{ xref: { "acme:MODEL-1": '{"confidence":"exact"}' } }`.
   */
  edgeData?: Record<string, Record<string, string>>;
  createdBy?: string;
}

export class RegistryService {
  private db: ReturnType<typeof drizzle>;
  readonly promotions: PromotionService;

  constructor(
    private readonly d1: D1Database,
    private readonly opts: {
      supportedLocales: readonly string[];
      defaultLocale: string;
      /**
       * Called after any write, with the collection apiIds whose cached
       * payloads are now stale. Supplied by `createRegistryQuery` so the
       * service stays free of a KV dependency (and testable without one).
       *
       * Without this, `findCached` would keep serving a pre-edit payload
       * for the full TTL — including after a collection was deleted.
       */
      onWrite?: (collectionApiIds: string[]) => void;
    },
  ) {
    this.db = drizzle(d1);
    this.promotions = new PromotionService(d1);
  }

  /**
   * Signal that these collections changed.
   *
   * Also invalidates every collection with a relation POINTING AT the
   * changed ones: their cached payloads embed the edited entries, and the
   * cache key's generation component covers each collection a query read.
   */
  private async invalidate(collectionApiIds: string[]): Promise<void> {
    if (!this.opts.onWrite) return;
    const touched = new Set(collectionApiIds);
    try {
      const all = await this.listCollectionsWithFields();
      for (const c of all) {
        for (const f of c.fields) {
          if (!RELATIONAL_FIELD_TYPES.has(f.type)) continue;
          const cfg = this.parseConfig(f);
          const targets =
            f.type === "relation"
              ? [(cfg as RelationFieldConfig).target]
              : ((cfg as ComponentFieldConfig).allowed ?? []);
          if (targets.some((t) => collectionApiIds.includes(t))) {
            touched.add(c.apiId);
          }
        }
      }
    } catch {
      // Fall back to invalidating just the named collections — a partial
      // invalidation beats none.
    }
    this.opts.onWrite(Array.from(touched));
  }

  private now() {
    return new Date().toISOString();
  }

  // ─── Collections ──────────────────────────────────────────

  async listCollections(): Promise<Collection[]> {
    return this.db
      .select()
      .from(collections)
      .orderBy(asc(collections.apiId))
      .all();
  }

  async getCollection(apiId: string): Promise<CollectionWithFields | null> {
    const collection = await this.db
      .select()
      .from(collections)
      .where(eq(collections.apiId, apiId))
      .limit(1)
      .get();
    if (!collection) return null;
    const fields = await this.db
      .select()
      .from(collectionFields)
      .where(eq(collectionFields.collectionId, collection.id))
      .orderBy(asc(collectionFields.position), asc(collectionFields.apiId))
      .all();
    return { ...collection, fields };
  }

  /**
   * Every collection with its fields, in one pair of queries.
   *
   * This is what builds the query-layer adapter's collection defs on
   * each request, so it must not be 1+N over collections.
   */
  async listCollectionsWithFields(): Promise<CollectionWithFields[]> {
    const all = await this.listCollections();
    if (all.length === 0) return [];
    const fields = await this.loadChunked(
      all.map((c) => c.id),
      (chunk) =>
        this.db
          .select()
          .from(collectionFields)
          .where(inArray(collectionFields.collectionId, chunk))
          .orderBy(asc(collectionFields.position), asc(collectionFields.apiId))
          .all(),
    );
    const byCollection = new Map<string, CollectionField[]>();
    for (const f of fields) {
      const list = byCollection.get(f.collectionId) ?? [];
      list.push(f);
      byCollection.set(f.collectionId, list);
    }
    return all.map((c) => ({ ...c, fields: byCollection.get(c.id) ?? [] }));
  }

  async createCollection(input: CreateCollectionInput): Promise<Collection> {
    assertValidApiId(input.apiId, "collection apiId");

    // A registry collection must not shadow a built-in one. The resolver
    // prefers built-ins, so the row would be silently unreachable — the
    // author would create a type, populate it, and never see it. Reject
    // up front instead.
    if (BUILTIN_COLLECTION_API_IDS.has(input.apiId)) {
      throw new RegistryError(
        `"${input.apiId}" is a built-in collection and cannot be redefined`,
        "DUPLICATE_API_ID",
      );
    }

    const existing = await this.db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.apiId, input.apiId))
      .limit(1)
      .get();
    if (existing) {
      throw new RegistryError(
        `A collection with apiId "${input.apiId}" already exists`,
        "DUPLICATE_API_ID",
      );
    }

    const id = nanoid();
    const now = this.now();
    await this.db.insert(collections).values({
      id,
      apiId: input.apiId,
      kind: input.kind ?? "collection",
      labelsJson: input.labels ? JSON.stringify(input.labels) : null,
      draftPublish: input.draftPublish ?? true,
      localized: input.localized ?? true,
      system: false,
      description: input.description ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await this.invalidate([input.apiId]);
    return (await this.db
      .select()
      .from(collections)
      .where(eq(collections.id, id))
      .get())!;
  }

  async deleteCollection(apiId: string): Promise<void> {
    const collection = await this.requireCollection(apiId);
    if (collection.system) {
      throw new RegistryError(
        `Collection "${apiId}" is engine-owned and cannot be deleted`,
        "SYSTEM_COLLECTION",
      );
    }
    // Refuse while other collections still point here: the edges would
    // cascade away silently and those collections' relation fields
    // would be left targeting something that no longer exists.
    const referencing = await this.findReferencingFields(apiId);
    if (referencing.length > 0) {
      throw new RegistryError(
        `Cannot delete "${apiId}" — still targeted by: ${referencing.join(", ")}`,
        "INVALID_CONFIG",
      );
    }
    // entries + fields cascade via FK.
    await this.db.delete(collections).where(eq(collections.id, collection.id));
    await this.invalidate([apiId]);
  }

  /** `collection.field` paths of every relation/component field targeting apiId. */
  private async findReferencingFields(apiId: string): Promise<string[]> {
    const all = await this.listCollectionsWithFields();
    const hits: string[] = [];
    for (const c of all) {
      if (c.apiId === apiId) continue;
      for (const f of c.fields) {
        if (!RELATIONAL_FIELD_TYPES.has(f.type)) continue;
        const cfg = this.parseConfig(f);
        if (
          f.type === "relation" &&
          (cfg as RelationFieldConfig).target === apiId
        ) {
          hits.push(`${c.apiId}.${f.apiId}`);
        }
        if (
          f.type === "component" &&
          (cfg as ComponentFieldConfig).allowed?.includes(apiId)
        ) {
          hits.push(`${c.apiId}.${f.apiId}`);
        }
      }
    }
    return hits;
  }

  // ─── Fields ───────────────────────────────────────────────

  async addField(
    collectionApiId: string,
    input: CreateFieldInput,
  ): Promise<CollectionField> {
    assertValidApiId(input.apiId, "field apiId");
    const collection = await this.requireCollection(collectionApiId);

    const config = validateFieldConfig(input.type, input.config ?? {});

    // A relation/component field must point at collections that exist,
    // or populate would fail at read time on every entry.
    await this.assertTargetsExist(input.type, config);

    const duplicate = await this.db
      .select({ id: collectionFields.id })
      .from(collectionFields)
      .where(
        and(
          eq(collectionFields.collectionId, collection.id),
          eq(collectionFields.apiId, input.apiId),
        ),
      )
      .limit(1)
      .get();
    if (duplicate) {
      throw new RegistryError(
        `Field "${input.apiId}" already exists on "${collectionApiId}"`,
        "DUPLICATE_API_ID",
      );
    }

    if (input.localized && !collection.localized) {
      throw new RegistryError(
        `Cannot add a localized field to "${collectionApiId}" — the collection is not localized`,
        "INVALID_CONFIG",
      );
    }
    if (input.promoted && RELATIONAL_FIELD_TYPES.has(input.type)) {
      throw new RegistryError(
        `Relational field "${input.apiId}" cannot be promoted — its values live in entry_relations, not the document`,
        "INVALID_CONFIG",
      );
    }

    const id = nanoid();
    const now = this.now();
    await this.db.insert(collectionFields).values({
      id,
      collectionId: collection.id,
      apiId: input.apiId,
      type: input.type,
      labelsJson: input.labels ? JSON.stringify(input.labels) : null,
      required: input.required ?? false,
      localized: input.localized ?? false,
      unique: input.unique ?? false,
      promoted: input.promoted ?? false,
      configJson: JSON.stringify(config),
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now,
    });

    // Promotion is real DDL, so it happens after the registry row is
    // committed: if the ALTER fails (budget exhausted) the definition
    // still stands and an admin can retry or un-promote, rather than
    // losing the field.
    if (input.promoted) {
      await this.promotions.promote({
        collectionApiId,
        fieldApiId: input.apiId,
        fieldType: input.type,
        localized: input.localized ?? false,
      });
    }

    await this.invalidate([collectionApiId]);
    return (await this.db
      .select()
      .from(collectionFields)
      .where(eq(collectionFields.id, id))
      .get())!;
  }

  async removeField(
    collectionApiId: string,
    fieldApiId: string,
  ): Promise<void> {
    const collection = await this.requireCollection(collectionApiId);
    const field = collection.fields.find((f) => f.apiId === fieldApiId);
    if (!field) {
      throw new RegistryError(
        `Field "${fieldApiId}" not found on "${collectionApiId}"`,
        "UNKNOWN_FIELD",
      );
    }
    if (field.promoted) {
      await this.promotions.unpromote({ collectionApiId, fieldApiId });
    }
    await this.db
      .delete(collectionFields)
      .where(eq(collectionFields.id, field.id));
    // Edges and index rows for this field are now orphaned; remove them
    // so a re-added field of the same name doesn't inherit stale data.
    await this.db
      .delete(entryRelations)
      .where(eq(entryRelations.fieldApiId, fieldApiId));
    await this.db
      .delete(entryFieldIndex)
      .where(eq(entryFieldIndex.fieldApiId, fieldApiId));
    // The value stays in each entry's dataJson. Deliberate: removing a
    // field by mistake shouldn't destroy content, and re-adding it
    // restores the data. Orphaned keys are ignored on read because
    // projection is driven by the registry, not by the document.
    await this.invalidate([collectionApiId]);
  }

  /** Reconcile promoted columns for every collection. Safe at boot. */
  async reconcilePromotions() {
    const all = await this.listCollectionsWithFields();
    const targets: PromotionTarget[] = [];
    for (const c of all) {
      for (const f of c.fields) {
        if (!f.promoted) continue;
        targets.push({
          collectionApiId: c.apiId,
          fieldApiId: f.apiId,
          fieldType: f.type,
          localized: f.localized,
        });
      }
    }
    return this.promotions.reconcile(targets);
  }

  // ─── Entries ──────────────────────────────────────────────

  async getEntry(id: string): Promise<Entry | null> {
    return (
      (await this.db.select().from(entries).where(eq(entries.id, id)).get()) ??
      null
    );
  }

  /**
   * Create or update an entry, its localizations, and its relation
   * edges.
   *
   * D1 has no interactive transactions, so this is a sequence of
   * statements rather than an atomic unit. Ordering is chosen so a
   * partial failure leaves something coherent: the base row first (an
   * entry with missing localizations is recoverable), edges last (they
   * are the cheapest to recompute).
   */
  async upsertEntry(
    collectionApiId: string,
    input: UpsertEntryInput,
  ): Promise<Entry> {
    const collection = await this.requireCollection(collectionApiId);
    const fieldsByApiId = new Map(collection.fields.map((f) => [f.apiId, f]));
    const now = this.now();

    // A `single` collection may only ever hold one entry.
    if (collection.kind === "single" && !input.id) {
      const existing = await this.db
        .select({ id: entries.id })
        .from(entries)
        .where(eq(entries.collectionId, collection.id))
        .limit(1)
        .get();
      if (existing) {
        throw new RegistryError(
          `Collection "${collectionApiId}" is a single type and already has an entry`,
          "CARDINALITY_VIOLATION",
        );
      }
    }

    // ── Validate the non-localized document
    const document = this.buildDocument(
      collection.fields.filter((f) => !f.localized),
      input.data ?? {},
      { requireAll: !input.id },
    );

    // ── Validate each locale's document
    //
    // On create, the default locale is validated even when the caller
    // sent no `localizations` at all: the loop below only visits locales
    // that were supplied, so omitting the key entirely would skip every
    // required-localized-field check — exactly the case those checks
    // exist for.
    const suppliedLocalizations = { ...(input.localizations ?? {}) };
    const hasRequiredLocalized = collection.fields.some(
      (f) => f.localized && f.required,
    );
    if (
      !input.id &&
      hasRequiredLocalized &&
      !suppliedLocalizations[this.opts.defaultLocale]
    ) {
      suppliedLocalizations[this.opts.defaultLocale] = {};
    }

    const localizedDocs: Record<string, Record<string, unknown>> = {};
    for (const [locale, values] of Object.entries(suppliedLocalizations)) {
      if (!this.opts.supportedLocales.includes(locale)) {
        throw new RegistryError(
          `Unsupported locale "${locale}". Supported: ${this.opts.supportedLocales.join(", ")}`,
          "INVALID_LOCALE",
        );
      }
      localizedDocs[locale] = this.buildDocument(
        collection.fields.filter((f) => f.localized),
        values,
        // Required localized fields are only enforced for the default
        // locale: demanding every translation up front would make a
        // partially-translated site impossible, which is the normal
        // editorial state.
        { requireAll: !input.id && locale === this.opts.defaultLocale },
      );
    }

    // ── Slug
    let slug = input.slug;
    if (slug !== undefined) {
      slug = slugify(slug);
    } else if (!input.id && collection.kind !== "component") {
      slug = this.deriveSlug(collection, localizedDocs, document);
    }
    if (slug) {
      await this.assertSlugAvailable(collection.id, slug, input.id);
    }

    // ── Uniqueness on fields marked unique
    await this.assertUniqueFields(
      collection,
      document,
      localizedDocs,
      input.id,
    );

    const entryId = input.id ?? nanoid();

    if (input.id) {
      const existing = await this.getEntry(input.id);
      if (!existing) {
        throw new RegistryError(
          `Entry "${input.id}" not found`,
          "UNKNOWN_COLLECTION",
        );
      }
      // Snapshot before mutating so history is complete (#68 §F).
      await this.snapshot(existing, input.createdBy ?? null);

      // Merge rather than replace: a caller sending only `{title}` must
      // not blank every other field.
      const merged = { ...safeParseObject(existing.dataJson), ...document };
      await this.db
        .update(entries)
        .set({
          ...(slug !== undefined ? { slug } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.publishedAt !== undefined
            ? { publishedAt: input.publishedAt }
            : {}),
          dataJson: JSON.stringify(merged),
          updatedAt: now,
        })
        .where(eq(entries.id, entryId));
    } else {
      const status =
        input.status ?? (collection.draftPublish ? "draft" : "published");
      await this.db.insert(entries).values({
        id: entryId,
        collectionId: collection.id,
        slug: slug ?? null,
        status,
        publishedAt: input.publishedAt ?? (status === "published" ? now : null),
        dataJson: JSON.stringify(document),
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    // ── Localizations (merge per locale, same reasoning as above)
    for (const [locale, doc] of Object.entries(localizedDocs)) {
      const existing = await this.db
        .select()
        .from(entryLocalizations)
        .where(
          and(
            eq(entryLocalizations.entryId, entryId),
            eq(entryLocalizations.locale, locale),
          ),
        )
        .limit(1)
        .get();
      if (existing) {
        const merged = { ...safeParseObject(existing.dataJson), ...doc };
        await this.db
          .update(entryLocalizations)
          .set({ dataJson: JSON.stringify(merged), updatedAt: now })
          .where(eq(entryLocalizations.id, existing.id));
      } else {
        await this.db.insert(entryLocalizations).values({
          id: nanoid(),
          entryId,
          locale,
          dataJson: JSON.stringify(doc),
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // ── Relation edges
    if (input.relations) {
      for (const [fieldApiId, targetIds] of Object.entries(input.relations)) {
        const field = fieldsByApiId.get(fieldApiId);
        if (!field || !RELATIONAL_FIELD_TYPES.has(field.type)) {
          throw new RegistryError(
            `"${fieldApiId}" is not a relation or component field on "${collectionApiId}"`,
            "UNKNOWN_FIELD",
          );
        }
        await this.setRelation(
          entryId,
          field,
          targetIds,
          input.edgeData?.[fieldApiId],
        );
      }
    }

    // ── Inverted index for filterable non-promoted fields
    await this.reindexEntry(entryId, collection, document, localizedDocs);

    await this.invalidate([collectionApiId]);
    return (await this.getEntry(entryId))!;
  }

  async deleteEntry(id: string): Promise<void> {
    // entry_localizations / entry_relations / entry_field_index /
    // entry_versions all cascade on the FK.
    await this.db.delete(entries).where(eq(entries.id, id));
  }

  // ─── Relations ────────────────────────────────────────────

  /**
   * Replace a field's edges with `targetIds`, in order.
   *
   * Replace rather than append: a form submits the full desired list, so
   * append semantics would make removal impossible.
   */
  async setRelation(
    entryId: string,
    field: CollectionField,
    /**
     * Entry ids, and/or external refs written `namespace:ref` (#99).
     * Order is significant — it becomes `position`.
     */
    targetIds: string[],
    /**
     * Optional edge attributes (#99), keyed by the same target string.
     * Data belonging to the PAIRING rather than either endpoint — a
     * confidence tier, a quantity, a validity window. Pre-serialized
     * JSON; the caller owns its shape, declared on the field's
     * `config.edgeFields`.
     */
    edgeData?: Record<string, string>,
  ): Promise<void> {
    const config = this.parseConfig(field);
    const cardinality =
      field.type === "relation"
        ? (config as RelationFieldConfig).cardinality
        : (config as ComponentFieldConfig).cardinality;

    const unique = Array.from(new Set(targetIds));
    if (cardinality === "one" && unique.length > 1) {
      throw new RegistryError(
        `Field "${field.apiId}" accepts a single target but ${unique.length} were given`,
        "CARDINALITY_VIOLATION",
      );
    }

    // #99: a target is either an entry id we own, or an EXTERNAL
    // reference written `namespace:ref`. Split them so each half is
    // validated against the rule that applies to it — entry ids must
    // resolve to an allowed collection; external refs must not be
    // validated against `entries` at all, since the whole point is that
    // we don't own them.
    const external = unique
      .filter((t) => t.includes(":"))
      .map((t) => {
        const idx = t.indexOf(":");
        return { namespace: t.slice(0, idx), ref: t.slice(idx + 1) };
      })
      .filter((e) => e.namespace && e.ref);
    const entryTargets = unique.filter((t) => !t.includes(":"));

    if (external.length > 0 && !allowsExternal(config)) {
      throw new RegistryError(
        `Field "${field.apiId}" does not accept external targets — set config.allowExternal to enable them`,
        "INVALID_VALUE",
      );
    }

    // Entry targets must exist and be of an allowed collection. Without
    // this an edge can point at an entry of the wrong type, and populate
    // would return objects with an unexpected shape.
    if (entryTargets.length > 0) {
      await this.assertValidTargets(field, config, entryTargets);
    }

    await this.db
      .delete(entryRelations)
      .where(
        and(
          eq(entryRelations.entryId, entryId),
          eq(entryRelations.fieldApiId, field.apiId),
        ),
      );

    if (unique.length === 0) return;

    const now = this.now();
    // Position is assigned across BOTH shapes in the order the caller
    // supplied, so a curated list mixing owned and external targets keeps
    // its authored order.
    let pos = 0;
    const rows = [
      ...entryTargets.map((targetEntryId) => ({
        id: nanoid(),
        entryId,
        fieldApiId: field.apiId,
        targetKind: "entry" as const,
        targetEntryId,
        targetNamespace: null,
        targetRef: null,
        targetLabel: null,
        dataJson: edgeData?.[targetEntryId] ?? null,
        position: pos++,
        createdAt: now,
      })),
      ...external.map((e) => ({
        id: nanoid(),
        entryId,
        fieldApiId: field.apiId,
        targetKind: "external" as const,
        targetEntryId: null,
        targetNamespace: e.namespace,
        targetRef: e.ref,
        targetLabel: null,
        dataJson: edgeData?.[`${e.namespace}:${e.ref}`] ?? null,
        position: pos++,
        createdAt: now,
      })),
    ];
    // 11 columns per row against D1's 100-parameter ceiling → 9 rows max
    // per statement. #99 widened the row from 6 columns to 11, so the
    // old divisor would have overflowed at 16 rows.
    const perStatement = Math.max(1, Math.floor(D1_MAX_BIND_PARAMS / 11));
    for (let i = 0; i < rows.length; i += perStatement) {
      await this.db
        .insert(entryRelations)
        .values(rows.slice(i, i + perStatement));
    }
  }

  private async assertValidTargets(
    field: CollectionField,
    config: unknown,
    targetIds: string[],
  ): Promise<void> {
    const allowedApiIds =
      field.type === "relation"
        ? [(config as RelationFieldConfig).target]
        : (config as ComponentFieldConfig).allowed;

    const allowed = await this.db
      .select({ id: collections.id, apiId: collections.apiId })
      .from(collections)
      .where(inArray(collections.apiId, allowedApiIds))
      .all();
    const allowedIds = new Set(allowed.map((c) => c.id));

    const found = await this.loadChunked(targetIds, (chunk) =>
      this.db
        .select({ id: entries.id, collectionId: entries.collectionId })
        .from(entries)
        .where(inArray(entries.id, chunk))
        .all(),
    );
    const foundById = new Map(found.map((e) => [e.id, e]));

    for (const targetId of targetIds) {
      const target = foundById.get(targetId);
      if (!target) {
        throw new RegistryError(
          `Field "${field.apiId}": target entry "${targetId}" does not exist`,
          "INVALID_VALUE",
        );
      }
      if (!allowedIds.has(target.collectionId)) {
        throw new RegistryError(
          `Field "${field.apiId}": target "${targetId}" is not one of ${allowedApiIds.join(", ")}`,
          "INVALID_VALUE",
        );
      }
    }
  }

  private async assertTargetsExist(
    type: FieldType,
    config: unknown,
  ): Promise<void> {
    if (!RELATIONAL_FIELD_TYPES.has(type)) return;
    const wanted =
      type === "relation"
        ? [(config as RelationFieldConfig).target]
        : (config as ComponentFieldConfig).allowed;
    const found = await this.db
      .select({ apiId: collections.apiId, kind: collections.kind })
      .from(collections)
      .where(inArray(collections.apiId, wanted))
      .all();
    const foundIds = new Set(found.map((c) => c.apiId));
    for (const apiId of wanted) {
      if (!foundIds.has(apiId)) {
        throw new RegistryError(
          `Target collection "${apiId}" does not exist`,
          "UNKNOWN_COLLECTION",
        );
      }
    }
    // A component field must point at component-kind collections; a
    // relation field must not. Mixing them would let a page embed a
    // whole addressable Article as if it were a layout block.
    if (type === "component") {
      for (const c of found) {
        if (c.kind !== "component") {
          throw new RegistryError(
            `"${c.apiId}" is a ${c.kind}, not a component — component fields may only nest component collections`,
            "INVALID_CONFIG",
          );
        }
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────

  private async requireCollection(
    apiId: string,
  ): Promise<CollectionWithFields> {
    const collection = await this.getCollection(apiId);
    if (!collection) {
      throw new RegistryError(
        `Unknown collection "${apiId}"`,
        "UNKNOWN_COLLECTION",
      );
    }
    return collection;
  }

  private parseConfig(field: CollectionField): unknown {
    return field.configJson ? safeParseObject(field.configJson) : {};
  }

  /**
   * Validate a set of incoming values against field definitions.
   *
   * Unknown keys are rejected rather than ignored: a typo'd field name
   * silently vanishing is how content goes missing without anyone
   * noticing.
   */
  private buildDocument(
    fields: CollectionField[],
    values: Record<string, unknown>,
    opts: { requireAll: boolean },
  ): Record<string, unknown> {
    const byApiId = new Map(fields.map((f) => [f.apiId, f]));
    for (const key of Object.keys(values)) {
      if (!byApiId.has(key)) {
        throw new RegistryError(`Unknown field "${key}"`, "UNKNOWN_FIELD");
      }
    }

    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (RELATIONAL_FIELD_TYPES.has(field.type)) continue;
      const provided = Object.prototype.hasOwnProperty.call(
        values,
        field.apiId,
      );
      // On update, a field the caller didn't mention keeps its stored
      // value — so "required" is only checked when the field is absent
      // on create, or explicitly cleared on update.
      if (!provided && !opts.requireAll) continue;
      const value = validateFieldValue(field, values[field.apiId]);
      if (value !== undefined) out[field.apiId] = value;
    }
    return out;
  }

  private deriveSlug(
    collection: CollectionWithFields,
    localizedDocs: Record<string, Record<string, unknown>>,
    document: Record<string, unknown>,
  ): string | undefined {
    // Prefer an explicit slug-typed field, then a title/name, mirroring
    // the repo's existing English-derived-slug convention.
    const slugField = collection.fields.find((f) => f.type === "slug");
    const titleField = collection.fields.find(
      (f) => f.apiId === "title" || f.apiId === "name",
    );
    const source =
      (slugField &&
        (document[slugField.apiId] ??
          localizedDocs[this.opts.defaultLocale]?.[slugField.apiId])) ??
      (titleField &&
        (document[titleField.apiId] ??
          localizedDocs[this.opts.defaultLocale]?.[titleField.apiId]));
    if (typeof source !== "string" || !source) return undefined;
    const slug = slugify(source);
    return slug || undefined;
  }

  private async assertSlugAvailable(
    collectionId: string,
    slug: string,
    excludeEntryId?: string,
  ): Promise<void> {
    const clash = await this.db
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(eq(entries.collectionId, collectionId), eq(entries.slug, slug)),
      )
      .limit(1)
      .get();
    if (clash && clash.id !== excludeEntryId) {
      throw new RegistryError(
        `Slug "${slug}" is already used in this collection`,
        "UNIQUE_VIOLATION",
      );
    }
  }

  /**
   * Enforce `unique` on fields that declare it.
   *
   * Uses the inverted index rather than scanning documents — that's what
   * it's for. Not race-free (D1 has no interactive transaction and this
   * is a check-then-write), so a simultaneous duplicate can slip
   * through; the check catches the realistic editorial case rather than
   * a deliberate race.
   */
  private async assertUniqueFields(
    collection: CollectionWithFields,
    document: Record<string, unknown>,
    localizedDocs: Record<string, Record<string, unknown>>,
    excludeEntryId?: string,
  ): Promise<void> {
    const uniqueFields = collection.fields.filter((f) => f.unique);
    if (uniqueFields.length === 0) return;

    for (const field of uniqueFields) {
      const column = indexColumnFor(field.type);
      if (!column) continue;

      // A localized unique field is unique PER LOCALE: two entries may
      // share an English name only if neither collides in the same
      // locale. Comparing the incoming default-locale value against
      // index rows for every locale (the earlier behaviour) made a Thai
      // value block an unrelated English one.
      const checks: { locale: string | null; value: unknown }[] =
        field.localized
          ? Object.entries(localizedDocs).map(([locale, doc]) => ({
              locale,
              value: doc[field.apiId],
            }))
          : [{ locale: null, value: document[field.apiId] }];

      for (const check of checks) {
        if (check.value === undefined || check.value === null) continue;

        // Joined against `entries` rather than using a subquery: scoping
        // by collection matters (two collections may both have a unique
        // `code`), and a real INNER JOIN is unambiguous across drizzle
        // versions where passing a query builder to inArray is not.
        const hits = await this.db
          .select({ entryId: entryFieldIndex.entryId })
          .from(entryFieldIndex)
          .innerJoin(entries, eq(entries.id, entryFieldIndex.entryId))
          .where(
            and(
              eq(entries.collectionId, collection.id),
              eq(entryFieldIndex.fieldApiId, field.apiId),
              eq(entryFieldIndex[column], check.value as never),
              check.locale === null
                ? isNull(entryFieldIndex.locale)
                : eq(entryFieldIndex.locale, check.locale),
            ),
          )
          .all();

        if (hits.some((h) => h.entryId !== excludeEntryId)) {
          throw new RegistryError(
            `Field "${field.apiId}" must be unique — value already used${
              check.locale ? ` in locale "${check.locale}"` : ""
            }`,
            "UNIQUE_VIOLATION",
          );
        }
      }
    }
  }

  /**
   * Rewrite this entry's rows in the inverted index.
   *
   * Only fields that are filterable and NOT promoted are indexed:
   * a promoted field already has a real generated column plus a real
   * index, so a row here would be pure duplication.
   */
  private async reindexEntry(
    entryId: string,
    collection: CollectionWithFields,
    document: Record<string, unknown>,
    localizedDocs: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await this.db
      .delete(entryFieldIndex)
      .where(eq(entryFieldIndex.entryId, entryId));

    const rows: (typeof entryFieldIndex.$inferInsert)[] = [];

    const push = (
      field: CollectionField,
      locale: string | null,
      value: unknown,
    ) => {
      const column = indexColumnFor(field.type);
      if (!column || value === undefined || value === null) return;
      rows.push({
        entryId,
        fieldApiId: field.apiId,
        locale,
        valueText: column === "valueText" ? String(value) : null,
        valueNumber: column === "valueNumber" ? Number(value) : null,
        valueBool: column === "valueBool" ? Boolean(value) : null,
      });
    };

    for (const field of collection.fields) {
      // A promoted field has a real generated column, so it does NOT need
      // an index row to be *filterable* — but it does need one to be
      // checked for uniqueness, because `assertUniqueFields` reads this
      // table. Skipping promoted fields here silently disabled `unique`
      // on exactly the fields most likely to declare it (a SKU or ref
      // code is the canonical case for BOTH flags). Verified: a duplicate
      // value on a unique+promoted field was accepted.
      //
      // The extra row is cheap and keeps uniqueness enforcement in one
      // place rather than forking on `promoted`.
      if (field.promoted && !field.unique) continue;
      if (field.localized) {
        for (const [locale, doc] of Object.entries(localizedDocs)) {
          push(field, locale, doc[field.apiId]);
        }
      } else {
        push(field, null, document[field.apiId]);
      }
    }

    if (rows.length === 0) return;
    // 6 columns per row → 16 rows per statement under the 100-param cap.
    const perStatement = Math.floor(D1_MAX_BIND_PARAMS / 6);
    for (let i = 0; i < rows.length; i += perStatement) {
      await this.db
        .insert(entryFieldIndex)
        .values(rows.slice(i, i + perStatement));
    }
  }

  /** Snapshot an entry's full state, including relations. */
  private async snapshot(entry: Entry, actorId: string | null): Promise<void> {
    const [locs, rels] = await Promise.all([
      this.db
        .select()
        .from(entryLocalizations)
        .where(eq(entryLocalizations.entryId, entry.id))
        .all(),
      this.db
        .select()
        .from(entryRelations)
        .where(eq(entryRelations.entryId, entry.id))
        .orderBy(asc(entryRelations.position))
        .all(),
    ]);
    await this.db.insert(entryVersions).values({
      id: nanoid(),
      entryId: entry.id,
      snapshotJson: JSON.stringify({
        slug: entry.slug,
        status: entry.status,
        publishedAt: entry.publishedAt,
        data: safeParseObject(entry.dataJson),
        localizations: Object.fromEntries(
          locs.map((l) => [l.locale, safeParseObject(l.dataJson)]),
        ),
        relations: rels.map((r) => ({
          fieldApiId: r.fieldApiId,
          targetEntryId: r.targetEntryId,
          position: r.position,
        })),
      }),
      createdBy: actorId,
      createdAt: this.now(),
    });
  }

  private async loadChunked<T>(
    ids: string[],
    load: (chunk: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    if (ids.length <= D1_MAX_BIND_PARAMS) return load(ids);
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += D1_MAX_BIND_PARAMS) {
      out.push(...(await load(ids.slice(i, i + D1_MAX_BIND_PARAMS))));
    }
    return out;
  }
}

/**
 * Whether a relation field accepts external (non-entry) targets (#99).
 *
 * Opt-in per field: a containment relation like Page→Block should never
 * point outside the CMS, and silently allowing it would let a typo'd
 * entry id be stored as an unresolvable external ref instead of failing.
 */
function allowsExternal(config: unknown): boolean {
  return (config as { allowExternal?: unknown })?.allowExternal === true;
}

function safeParseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
