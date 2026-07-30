/**
 * Query layer public surface — Phase 1 (#68).
 *
 * `createQueryEngine(env)` is what call sites use. The cached variant
 * is opt-in per call rather than automatic: caching an admin/preview
 * read that can contain unpublished drafts would be a correctness bug,
 * so the caller has to say "this read is public and cacheable."
 */
import { QueryEngine, type QueryEngineOptions } from "./engine";
import { QueryCache, collectionsTouched } from "./cache";
import { getCollection } from "./registry";
import type { EntryRow, FindQuery, FindResult } from "./types";

export { QueryEngine } from "./engine";
export { QueryCache } from "./cache";
export {
  COLLECTIONS,
  getCollection,
  listCollectionIds,
  type CollectionDef,
  type RelationDef,
} from "./registry";
export {
  parseFindQuery,
  parseFields,
  parseFilters,
  parsePopulate,
  parseSort,
} from "./params";
export {
  MAX_POPULATE_DEPTH,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  QueryError,
  type EntryRow,
  type Filters,
  type FindQuery,
  type FindResult,
  type PopulateNode,
  type PopulateSpec,
} from "./types";

/** Where a relation points, or null if it doesn't exist. */
function resolveRelationTarget(
  collection: string,
  relation: string,
): string | null {
  const def = getCollection(collection);
  if (!def) return null;
  if (relation === "*") return null; // expanded by the engine, not a target
  const rel = def.relations[relation];
  if (!rel) return null;
  switch (rel.kind) {
    // Localizations live in a sibling table of the same collection —
    // there is no separate target collection to invalidate.
    case "localizations":
    case "entryLocalizations":
      return collection;
    case "manyToOne":
    case "manyToMany":
    case "entryRelation":
      return rel.target;
  }
}

export interface ContentQuery {
  find(collection: string, query?: FindQuery): Promise<FindResult>;
  findOne(
    collection: string,
    query?: Omit<FindQuery, "page" | "limit">,
  ): Promise<EntryRow | null>;
  /**
   * Cached read. Only for public, published-only queries — see the
   * note in cache.ts about never caching draft-visible reads.
   */
  findCached(
    collection: string,
    query?: FindQuery,
    ttlSeconds?: number,
  ): Promise<FindResult>;
  /** Bump the generation for these collections after a write. */
  invalidate(collections: string[]): Promise<void>;
  /** Queries issued by the underlying engine (for tests / meta). */
  readonly issuedQueries: number;
}

export function createQueryEngine(
  env: App.Platform["env"],
  opts?: Partial<QueryEngineOptions>,
): ContentQuery {
  const supportedLocales =
    opts?.supportedLocales ??
    (env.SUPPORTED_LOCALES ?? "en,th")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
  const defaultLocale =
    opts?.defaultLocale ?? env.DEFAULT_LOCALE ?? supportedLocales[0] ?? "en";

  const engine = new QueryEngine(env.DB, { supportedLocales, defaultLocale });
  const cache = env.CONTENT_CACHE ? new QueryCache(env.CONTENT_CACHE) : null;

  return {
    find: (collection, query) => engine.find(collection, query ?? {}),
    findOne: (collection, query) => engine.findOne(collection, query ?? {}),

    async findCached(collection, query = {}, ttlSeconds) {
      if (!cache) return engine.find(collection, query);
      const touched = collectionsTouched(
        collection,
        query,
        resolveRelationTarget,
      );
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

    get issuedQueries() {
      return engine.issuedQueries;
    },
  };
}
