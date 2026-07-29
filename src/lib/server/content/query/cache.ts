/**
 * KV cache for assembled populate payloads — Phase 1 (#68 §D).
 *
 * `CONTENT_CACHE` has been bound since v1.0 but only ever
 * health-probed (`api/health/+server.ts:41`). A deep populate is
 * exactly what it's for: the result is expensive to assemble (several
 * round trips), identical for every visitor, and changes only on
 * write.
 *
 * ## Invalidation
 *
 * Per-key TTL plus a **generation counter per collection**. The
 * generation is embedded in every cache key, so bumping it makes all
 * existing keys for that collection unreachable in one write — no
 * key enumeration, which KV does not do cheaply or atomically.
 *
 * Populate spans collections (an article payload embeds categories and
 * tags), so a key's generation component is the concatenation of the
 * generations of **every collection the query touched**. Editing a
 * category therefore invalidates the article payloads that embedded
 * it, without those payloads needing to know they existed.
 *
 * ## Deliberately not cached
 *
 * Only published, non-draft reads should reach this. Admin/preview
 * traffic bypasses it entirely — a cache that can serve an unpublished
 * draft to the public is a correctness bug, not a performance win.
 * Callers opt in explicitly rather than the cache guessing.
 */
import type { FindQuery, FindResult } from "./types";

/** Assembled payloads are cheap to rebuild; keep the TTL modest. */
export const DEFAULT_TTL_SECONDS = 300;

/** KV rejects TTLs under 60s. */
const MIN_TTL_SECONDS = 60;

const GENERATION_PREFIX = "gen:";
const PAYLOAD_PREFIX = "q:";

export interface CacheDeps {
  kv: KVNamespace;
}

/**
 * Stable stringify — key order must not change the hash, or two
 * identical queries written in different orders would miss each other.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * FNV-1a. Not cryptographic — this only needs to distribute query
 * shapes across key space, and a collision costs a wrong cache hit for
 * one query shape, which the generation counter will clear anyway.
 * Kept in-process because SubtleCrypto is async and this sits on the
 * hot read path.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export class QueryCache {
  constructor(private readonly kv: KVNamespace) {}

  /**
   * Current generation for each collection, as one batched read.
   * A missing counter reads as "0" — a cold cache is a miss, never an
   * error.
   */
  private async generations(collections: string[]): Promise<string> {
    const unique = Array.from(new Set(collections)).sort();
    const values = await Promise.all(
      unique.map((c) =>
        this.kv.get(`${GENERATION_PREFIX}${c}`).catch(() => null),
      ),
    );
    return unique.map((c, i) => `${c}=${values[i] ?? "0"}`).join("&");
  }

  /**
   * Cache key for a query. `collections` must list every collection
   * the query reads — root plus every populate target — so that
   * editing any of them invalidates this entry.
   */
  private async key(
    collection: string,
    query: FindQuery,
    collections: string[],
  ): Promise<string> {
    const gen = await this.generations(collections);
    const shape = stableStringify({ collection, query });
    return `${PAYLOAD_PREFIX}${collection}:${hash(gen)}:${hash(shape)}`;
  }

  async get(
    collection: string,
    query: FindQuery,
    collections: string[],
  ): Promise<FindResult | null> {
    try {
      const raw = await this.kv.get(
        await this.key(collection, query, collections),
        "json",
      );
      return (raw as FindResult | null) ?? null;
    } catch {
      // A cache read must never break a page render.
      return null;
    }
  }

  async set(
    collection: string,
    query: FindQuery,
    collections: string[],
    value: FindResult,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    try {
      await this.kv.put(
        await this.key(collection, query, collections),
        JSON.stringify(value),
        {
          expirationTtl: Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
        },
      );
    } catch {
      /* best-effort — a failed cache write is not a failed request */
    }
  }

  /**
   * Bump a collection's generation, orphaning every cached payload
   * that read it. Call after any write to that collection.
   *
   * Not atomic (KV has no compare-and-swap): two concurrent bumps can
   * land on the same number. That's harmless here — the only effect is
   * that one of two simultaneous invalidations is redundant, and both
   * still move the generation off the value cached before them.
   */
  async invalidate(collection: string): Promise<void> {
    try {
      const key = `${GENERATION_PREFIX}${collection}`;
      const current = Number((await this.kv.get(key)) ?? "0");
      const next = Number.isFinite(current) ? current + 1 : 1;
      // No TTL: generation counters must outlive the payloads they
      // guard, or an expired counter would silently resurrect stale
      // entries cached under the old generation.
      await this.kv.put(key, String(next));
    } catch {
      /* best-effort */
    }
  }

  /** Invalidate several collections — e.g. a write touching a join table. */
  async invalidateMany(collections: string[]): Promise<void> {
    await Promise.all(
      Array.from(new Set(collections)).map((c) => this.invalidate(c)),
    );
  }
}

/**
 * Every collection a query reads: the root, plus each populate target,
 * resolved recursively. Used to build the generation component of the
 * cache key.
 */
export function collectionsTouched(
  rootCollection: string,
  query: FindQuery,
  resolveRelationTarget: (
    collection: string,
    relation: string,
  ) => string | null,
): string[] {
  const seen = new Set<string>([rootCollection]);

  const walk = (
    collection: string,
    populate: FindQuery["populate"],
    depth: number,
  ): void => {
    if (!populate || depth > 8) return;
    for (const [name, spec] of Object.entries(populate)) {
      if (spec === false) continue;
      const target = resolveRelationTarget(collection, name);
      if (!target) continue;
      seen.add(target);
      if (spec && typeof spec === "object" && spec.populate) {
        walk(target, spec.populate, depth + 1);
      }
    }
  };

  walk(rootCollection, query.populate, 1);
  return Array.from(seen);
}
