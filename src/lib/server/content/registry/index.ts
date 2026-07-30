/**
 * Registry public surface — Phase 2 (#68).
 *
 * `createRegistryQuery(env)` returns a query interface that resolves
 * BOTH the built-in code-defined collections and the user-defined
 * registry collections through the same Phase 1 engine.
 *
 * Resolution order matters: built-in collections win on a name
 * collision, so a user cannot shadow `articles` with a registry
 * collection of the same apiId and change what the public API returns.
 * `createCollection` rejects those names up front too; this is the
 * second line of defence.
 */
import { QueryEngine } from "../query/engine";
import { QueryCache, collectionsTouched } from "../query/cache";
import {
  getCollection as getBuiltinCollection,
  listCollectionIds as listBuiltinIds,
  type CollectionDef,
} from "../query/registry";
import type { EntryRow, FindQuery, FindResult } from "../query/types";
import { toCollectionDef } from "./adapter";
import { RegistryService } from "./service";

export { RegistryService } from "./service";
export { PromotionService, MAX_PROMOTED_FIELDS } from "./promote";
export { toCollectionDef } from "./adapter";
export {
  RegistryError,
  assertValidApiId,
  validateFieldConfig,
  API_ID_PATTERN,
  PROMOTABLE_FIELD_TYPES,
  RELATIONAL_FIELD_TYPES,
} from "./types";
export { validateFieldValue } from "./validate";
export * from "./schema";
export type {
  CollectionWithFields,
  CreateCollectionInput,
  CreateFieldInput,
  UpsertEntryInput,
} from "./service";

export interface RegistryQuery {
  /** Every queryable collection apiId, built-in and registry. */
  listCollections(): Promise<string[]>;
  find(collection: string, query?: FindQuery): Promise<FindResult>;
  findOne(
    collection: string,
    query?: Omit<FindQuery, "page" | "limit">,
  ): Promise<EntryRow | null>;
  findCached(
    collection: string,
    query?: FindQuery,
    ttlSeconds?: number,
  ): Promise<FindResult>;
  invalidate(collections: string[]): Promise<void>;
  /** The write API — collections, fields, entries, relations. */
  readonly service: RegistryService;
}

export function createRegistryQuery(env: App.Platform["env"]): RegistryQuery {
  const supportedLocales = (env.SUPPORTED_LOCALES ?? "en,th")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const defaultLocale = env.DEFAULT_LOCALE ?? supportedLocales[0] ?? "en";

  const cache = env.CONTENT_CACHE ? new QueryCache(env.CONTENT_CACHE) : null;

  const service = new RegistryService(env.DB, {
    supportedLocales,
    defaultLocale,
    // Registry writes must drop cached payloads, or `findCached` keeps
    // serving pre-edit content for the full TTL. Fire-and-forget: a
    // failed invalidation must not fail the write, and the TTL bounds
    // the damage. Callers with an execution context should prefer
    // `invalidate()` under waitUntil.
    onWrite: cache
      ? (collectionApiIds) => void cache.invalidateMany(collectionApiIds)
      : undefined,
  });

  /**
   * Registry defs, built once per request and memoized.
   *
   * Two queries (collections + their fields) shared across every
   * collection touched by one request's populate tree — rebuilding per
   * lookup would reintroduce exactly the N+1 Phase 1 removed.
   */
  let defsPromise: Promise<{
    all: Map<string, CollectionDef>;
    roots: Map<string, CollectionDef>;
  }> | null = null;
  const registryDefs = () => {
    if (!defsPromise) {
      defsPromise = service.listCollectionsWithFields().then((collections) => {
        const all = new Map<string, CollectionDef>();
        const roots = new Map<string, CollectionDef>();
        for (const collection of collections) {
          const def = toCollectionDef(collection);
          // Components must stay RESOLVABLE — a component field's
          // populate target is a component collection, and omitting them
          // from resolution makes `populate=*` throw UNKNOWN_COLLECTION
          // on any collection that has one.
          all.set(collection.apiId, def);
          // But they are not addressable on their own: exposing them as
          // query roots would let a caller enumerate page fragments
          // outside the page that owns them.
          if (collection.kind !== "component") {
            roots.set(collection.apiId, def);
          }
        }
        return { all, roots };
      });
    }
    return defsPromise;
  };

  /**
   * Resolve a collection by apiId across both sources, built-in first.
   *
   * The engine takes a synchronous resolver, so registry defs are loaded
   * before the query runs and handed over as a plain lookup.
   */
  const buildResolver = async () => {
    const { all } = await registryDefs();
    return (apiId: string): CollectionDef | null =>
      getBuiltinCollection(apiId) ?? all.get(apiId) ?? null;
  };

  const engineFor = async () => {
    const resolve = await buildResolver();
    return new QueryEngine(
      env.DB,
      { supportedLocales, defaultLocale },
      resolve,
    );
  };

  return {
    async listCollections() {
      // Roots only — this is what the public endpoint gates on, so
      // components must not appear or they'd become addressable.
      const { roots } = await registryDefs();
      return [...listBuiltinIds(), ...roots.keys()];
    },

    async find(collection, query = {}) {
      return (await engineFor()).find(collection, query);
    },

    async findOne(collection, query = {}) {
      return (await engineFor()).findOne(collection, query);
    },

    async findCached(collection, query = {}, ttlSeconds) {
      const engine = await engineFor();
      if (!cache) return engine.find(collection, query);
      const resolve = await buildResolver();
      const touched = collectionsTouched(collection, query, (c, relation) => {
        const def = resolve(c);
        if (!def || relation === "*") return null;
        const rel = def.relations[relation];
        if (!rel) return null;
        return rel.kind === "localizations" || rel.kind === "entryLocalizations"
          ? c
          : rel.target;
      });
      const hit = await cache.get(collection, query, touched);
      if (hit) return hit;
      const fresh = await engine.find(collection, query);
      await cache.set(collection, query, touched, fresh, ttlSeconds);
      return fresh;
    },

    async invalidate(collections) {
      if (!cache) return;
      await cache.invalidateMany(collections);
    },

    service,
  };
}
