/**
 * Generic query engine — Phase 1 (#68 §D).
 *
 * ## The problem this exists to fix
 *
 * `D1ContentProvider.listArticles` runs the base query, then calls
 * `hydrateArticle` **per row**, and each of those fires 2 more queries
 * (localizations + tags). A 20-item list is **1 + 40 queries**
 * (d1.ts:176, :538). That doesn't survive nesting: adding a second
 * level multiplies rather than adds.
 *
 * ## The fix: breadth-first, one query per relation per level
 *
 * Populate is resolved **level by level**, not row by row:
 *
 *   1. Load the root rows (1 query, + 1 count).
 *   2. Collect every id needed for level-1 relations across ALL root
 *      rows at once.
 *   3. Issue ONE batched `inArray` query per relation.
 *   4. Stitch results back onto the rows in memory.
 *   5. Repeat for level 2 using the rows just loaded.
 *
 * Query count becomes a function of the *shape* of the populate tree,
 * not the *number of rows*. 20 articles with `populate=category,tags`
 * goes from 41 queries to 4, and stays 4 at 100 articles.
 *
 * This is the same `inArray` technique already used ad hoc at
 * d1.ts:140 and in the shop's cart-service, applied systematically.
 *
 * Worth noting from the Phase 2 research: Payload — the closest
 * architectural sibling — does NOT use real SQL joins for `hasMany`
 * relations either; it excludes them from its join tree and populates
 * with follow-up queries. Batched populate is the required approach on
 * a relational store regardless of how schema is defined, which is why
 * this layer is independent of the Phase 2 storage decision.
 */
import { drizzle } from "drizzle-orm/d1";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  getTableColumns,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import { type SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  getCollection,
  type CollectionDef,
  type RelationDef,
} from "./registry";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_POPULATE_DEPTH,
  QueryError,
  type EntryRow,
  type Filters,
  type FindQuery,
  type FindResult,
  type PopulateNode,
  type PopulateSpec,
} from "./types";

/**
 * D1 binds at most 100 parameters per statement. Every batched
 * `inArray` load chunks to this size — see `loadChunked`.
 */
const MAX_BIND_PARAMS = 100;

/** Column lookup that tolerates the drizzle table type being opaque. */
function columnsOf(table: SQLiteTable): Record<string, unknown> {
  return getTableColumns(table) as unknown as Record<string, unknown>;
}

function requireColumn(
  table: SQLiteTable,
  name: string,
  ctx: string,
): SQLiteColumnLike {
  const col = columnsOf(table)[name];
  if (!col) {
    throw new QueryError(`Unknown field "${name}" on ${ctx}`, "UNKNOWN_FIELD");
  }
  return col as SQLiteColumnLike;
}

/**
 * Stand-in for a drizzle column. The concrete type is generic over ~8
 * params; we only ever hand these straight back to drizzle's own
 * operators, so the loosest `Column` keeps call sites readable without
 * `any` leaking into the public surface.
 */
type SQLiteColumnLike = Column;

/** Normalizes a populate spec to its object form. */
function toNode(spec: PopulateSpec): PopulateNode {
  return spec === true ? {} : spec === false ? {} : spec;
}

export interface QueryEngineOptions {
  /**
   * Locales accepted by `locale` params. Comes from the runtime
   * supported-locale list, NOT a compile-time enum — #68 §E calls for
   * dropping the hardcoded `["th","en"]` assumption, and Phase 2
   * requires an arbitrary locale set.
   */
  supportedLocales: readonly string[];
  /** Canonical fallback when a row has no row for the asked locale. */
  defaultLocale: string;
}

export class QueryEngine {
  private db: ReturnType<typeof drizzle>;
  /** Incremented per issued query so callers can assert on N+1. */
  private queryCount = 0;

  constructor(
    d1: D1Database,
    private readonly opts: QueryEngineOptions,
  ) {
    this.db = drizzle(d1);
  }

  /** Queries issued since construction. Used by tests and `meta`. */
  get issuedQueries(): number {
    return this.queryCount;
  }

  async findOne(
    collectionId: string,
    query: Omit<FindQuery, "page" | "limit"> = {},
  ): Promise<EntryRow | null> {
    const res = await this.find(collectionId, { ...query, page: 1, limit: 1 });
    return res.data[0] ?? null;
  }

  async find(collectionId: string, query: FindQuery = {}): Promise<FindResult> {
    const collection = getCollection(collectionId);
    if (!collection) {
      throw new QueryError(
        `Unknown collection "${collectionId}"`,
        "UNKNOWN_COLLECTION",
      );
    }

    const locale = this.validateLocale(query.locale);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)),
    );
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const offset = (page - 1) * limit;

    this.assertDepth(query.populate, 1);

    const where = this.buildWhere(
      collection,
      query.filters,
      query.onlyPublished,
    );
    const orderBy = this.buildOrderBy(collection, query.sort);

    const [rows, countRow] = await Promise.all([
      this.tracked(() =>
        this.db
          .select()
          .from(collection.table)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset)
          .all(),
      ),
      this.tracked(() =>
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(collection.table)
          .where(where)
          .get(),
      ),
    ]);

    const data = (rows as EntryRow[]).map((r) =>
      this.projectScalars(collection, r, query.fields),
    );

    if (query.populate && data.length > 0) {
      await this.populateLevel(
        collection,
        rows as EntryRow[],
        data,
        query.populate,
        locale,
        1,
      );
    }

    const total = countRow?.count ?? 0;
    return {
      data,
      meta: {
        total,
        page,
        limit,
        pageCount: Math.ceil(total / limit),
        queryCount: this.queryCount,
      },
    };
  }

  // ─── Populate ─────────────────────────────────────────────

  /**
   * Resolve one level of the populate tree for a set of already-loaded
   * rows, then recurse. Exactly one query per relation at this level,
   * regardless of how many rows there are.
   *
   * `sourceRows` are the raw DB rows (needed for FK values, which may
   * have been projected away); `targetRows` are the caller-visible
   * objects the results get attached to. They are index-aligned.
   */
  private async populateLevel(
    collection: CollectionDef,
    sourceRows: EntryRow[],
    targetRows: EntryRow[],
    populate: Record<string, PopulateSpec>,
    inheritedLocale: string | undefined,
    depth: number,
  ): Promise<void> {
    // `populate=*` — every relation of this collection, one level deep,
    // with default fields. Expanded here rather than in the parser
    // because only the registry knows what "every relation" means.
    const expanded: Record<string, PopulateSpec> =
      populate["*"] !== undefined && populate["*"] !== false
        ? Object.fromEntries(
            Object.keys(collection.relations).map((name) => [name, true]),
          )
        : populate;

    for (const [relationName, spec] of Object.entries(expanded)) {
      if (spec === false) continue;
      const relation = collection.relations[relationName];
      if (!relation) {
        throw new QueryError(
          `Unknown relation "${relationName}" on ${collection.apiId}`,
          "UNKNOWN_RELATION",
        );
      }
      const node = toNode(spec);
      const locale = node.locale
        ? this.validateLocale(node.locale)
        : inheritedLocale;

      await this.resolveRelation(
        relation,
        relationName,
        sourceRows,
        targetRows,
        node,
        locale,
        depth,
        collection,
      );
    }
  }

  private async resolveRelation(
    relation: RelationDef,
    relationName: string,
    sourceRows: EntryRow[],
    targetRows: EntryRow[],
    node: PopulateNode,
    locale: string | undefined,
    depth: number,
    parent: CollectionDef,
  ): Promise<void> {
    switch (relation.kind) {
      case "localizations":
        return this.resolveLocalizations(
          relation,
          relationName,
          sourceRows,
          targetRows,
          locale,
          parent,
        );
      case "manyToOne":
        return this.resolveManyToOne(
          relation,
          relationName,
          sourceRows,
          targetRows,
          node,
          locale,
          depth,
        );
      case "manyToMany":
        return this.resolveManyToMany(
          relation,
          relationName,
          sourceRows,
          targetRows,
          node,
          locale,
          depth,
          parent,
        );
    }
  }

  /**
   * Base-row + sibling `_localizations` — the repo's convention. ONE
   * query for every parent row, grouped in memory into
   * `{ en: {...}, th: {...} }`, matching the existing `ArticleRecord`
   * shape so callers can swap onto this without reshaping.
   */
  private async resolveLocalizations(
    relation: Extract<RelationDef, { kind: "localizations" }>,
    relationName: string,
    sourceRows: EntryRow[],
    targetRows: EntryRow[],
    locale: string | undefined,
    parent: CollectionDef,
  ): Promise<void> {
    const ids = this.collectIds(sourceRows, parent.primaryKey);
    if (ids.length === 0) return;

    const fkCol = requireColumn(
      relation.table,
      relation.foreignKey,
      "localizations",
    );
    // Extra conditions applied to every chunk alongside its id slice.
    const extra: SQL[] = locale
      ? [eq(requireColumn(relation.table, "locale", "locale"), locale)]
      : [];

    const locRows = (await this.loadChunked(ids, (chunk) =>
      this.db
        .select()
        .from(relation.table)
        .where(and(inArray(fkCol, chunk), ...extra))
        .all(),
    )) as EntryRow[];

    const byParent = new Map<string, Record<string, unknown>>();
    for (const row of locRows) {
      const parentId = String(row[relation.foreignKey]);
      const rowLocale = String(row.locale);
      const bucket = byParent.get(parentId) ?? {};
      const payload: Record<string, unknown> = {};
      for (const f of relation.fields) payload[f] = row[f] ?? null;
      bucket[rowLocale] = payload;
      byParent.set(parentId, bucket);
    }

    for (let i = 0; i < targetRows.length; i++) {
      const id = String(sourceRows[i][parent.primaryKey]);
      targetRows[i][relationName] = byParent.get(id) ?? {};
    }
  }

  /** FK column on this table → one batched load of the target. */
  private async resolveManyToOne(
    relation: Extract<RelationDef, { kind: "manyToOne" }>,
    relationName: string,
    sourceRows: EntryRow[],
    targetRows: EntryRow[],
    node: PopulateNode,
    locale: string | undefined,
    depth: number,
  ): Promise<void> {
    const target = getCollection(relation.target);
    if (!target) {
      throw new QueryError(
        `Relation "${relationName}" targets unknown collection "${relation.target}"`,
        "UNKNOWN_COLLECTION",
      );
    }

    const localKey = relation.localKey;
    const ids = this.collectIds(sourceRows, localKey);
    if (ids.length === 0) {
      // Every parent had a null FK — still set the key so the shape is
      // stable for consumers rather than silently absent.
      for (const row of targetRows) row[relationName] = null;
      return;
    }

    const targetKey = relation.targetKey ?? target.primaryKey;
    const targetCol = requireColumn(target.table, targetKey, target.apiId);

    const rows = (await this.loadChunked(ids, (chunk) =>
      this.db
        .select()
        .from(target.table)
        .where(inArray(targetCol, chunk))
        .all(),
    )) as EntryRow[];

    const projected = rows.map((r) =>
      this.projectScalars(target, r, node.fields),
    );
    const byId = new Map<string, EntryRow>();
    projected.forEach((p, i) => byId.set(String(rows[i][targetKey]), p));

    for (let i = 0; i < targetRows.length; i++) {
      const fk = sourceRows[i][localKey];
      targetRows[i][relationName] =
        fk == null ? null : (byId.get(String(fk)) ?? null);
    }

    if (node.populate && rows.length > 0) {
      this.assertDepth(node.populate, depth + 1);
      await this.populateLevel(
        target,
        rows,
        projected,
        node.populate,
        locale,
        depth + 1,
      );
    }
  }

  /**
   * Join table → two batched queries total (edges, then targets),
   * regardless of parent count. Order of the joined array follows the
   * target load; the current join tables carry no explicit position
   * column (Phase 2's `entry_relations` adds one).
   */
  private async resolveManyToMany(
    relation: Extract<RelationDef, { kind: "manyToMany" }>,
    relationName: string,
    sourceRows: EntryRow[],
    targetRows: EntryRow[],
    node: PopulateNode,
    locale: string | undefined,
    depth: number,
    parent: CollectionDef,
  ): Promise<void> {
    const target = getCollection(relation.target);
    if (!target) {
      throw new QueryError(
        `Relation "${relationName}" targets unknown collection "${relation.target}"`,
        "UNKNOWN_COLLECTION",
      );
    }

    const parentIds = this.collectIds(sourceRows, parent.primaryKey);
    if (parentIds.length === 0) return;

    const throughLocal = requireColumn(
      relation.through,
      relation.throughLocalKey,
      "join table",
    );

    const edges = (await this.loadChunked(parentIds, (chunk) =>
      this.db
        .select()
        .from(relation.through)
        .where(inArray(throughLocal, chunk))
        .all(),
    )) as EntryRow[];

    if (edges.length === 0) {
      for (const row of targetRows) row[relationName] = [];
      return;
    }

    const targetIds = Array.from(
      new Set(edges.map((e) => String(e[relation.throughTargetKey]))),
    );

    const rows = (await this.loadChunked(targetIds, (chunk) =>
      this.db
        .select()
        .from(target.table)
        .where(
          inArray(
            requireColumn(target.table, target.primaryKey, target.apiId),
            chunk,
          ),
        )
        .all(),
    )) as EntryRow[];

    const projected = rows.map((r) =>
      this.projectScalars(target, r, node.fields),
    );
    const byId = new Map<string, EntryRow>();
    projected.forEach((p, i) =>
      byId.set(String(rows[i][target.primaryKey]), p),
    );

    const grouped = new Map<string, EntryRow[]>();
    for (const edge of edges) {
      const parentId = String(edge[relation.throughLocalKey]);
      const hit = byId.get(String(edge[relation.throughTargetKey]));
      if (!hit) continue;
      const list = grouped.get(parentId) ?? [];
      list.push(hit);
      grouped.set(parentId, list);
    }

    for (let i = 0; i < targetRows.length; i++) {
      const id = String(sourceRows[i][parent.primaryKey]);
      targetRows[i][relationName] = grouped.get(id) ?? [];
    }

    if (node.populate && rows.length > 0) {
      this.assertDepth(node.populate, depth + 1);
      await this.populateLevel(
        target,
        rows,
        projected,
        node.populate,
        locale,
        depth + 1,
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────

  /**
   * Run an `inArray` load in chunks that respect D1's bound-parameter
   * ceiling (100 per statement).
   *
   * Without this, `?limit=100&populate=tags` binds 100 parent ids in one
   * statement and fails outright — and the failure is invisible until a
   * site actually has that much content. The per-row hydration this
   * layer replaces never hit the limit because it bound exactly one id
   * at a time; batching is what introduces the constraint.
   *
   * Chunks run sequentially: D1 counts every subrequest against the
   * per-invocation query budget, and firing an unbounded number in
   * parallel is how you exhaust it.
   */
  private async loadChunked<T>(
    ids: string[],
    load: (chunk: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    if (ids.length <= MAX_BIND_PARAMS) return this.tracked(() => load(ids));

    const out: T[] = [];
    for (let i = 0; i < ids.length; i += MAX_BIND_PARAMS) {
      const chunk = ids.slice(i, i + MAX_BIND_PARAMS);
      out.push(...(await this.tracked(() => load(chunk))));
    }
    return out;
  }

  /** Distinct, non-null values of `key` across rows. */
  private collectIds(rows: EntryRow[], key: string): string[] {
    const set = new Set<string>();
    for (const row of rows) {
      const v = row[key];
      if (v != null) set.add(String(v));
    }
    return Array.from(set);
  }

  /**
   * Restrict a row to the collection's `selectable` allowlist, then to
   * the caller's `fields` if given. An unknown requested field is an
   * error rather than a silent omission — a typo'd `fields` param
   * should not quietly return less data.
   */
  private projectScalars(
    collection: CollectionDef,
    row: EntryRow,
    fields?: string[],
  ): EntryRow {
    const allowed = fields
      ? fields.map((f) => {
          if (!collection.selectable.includes(f)) {
            throw new QueryError(
              `Unknown field "${f}" on ${collection.apiId}`,
              "UNKNOWN_FIELD",
            );
          }
          return f;
        })
      : collection.selectable;

    const out: EntryRow = {};
    for (const f of allowed) out[f] = row[f] ?? null;
    // The primary key always rides along — populate stitching and any
    // client-side cache keying need it, and omitting it makes results
    // ambiguous.
    if (!(collection.primaryKey in out)) {
      out[collection.primaryKey] = row[collection.primaryKey];
    }
    return out;
  }

  private buildWhere(
    collection: CollectionDef,
    filters?: Filters,
    onlyPublished?: boolean,
  ): SQL | undefined {
    const conditions: SQL[] = [];

    // Scheduled-publishing guard. Applied before user filters so it
    // can't be displaced by them, and expressed as a disjunction the
    // `filters` grammar has no syntax for:
    //   publishedAt IS NULL OR publishedAt <= now
    if (onlyPublished && collection.filterable.includes("publishedAt")) {
      const col = requireColumn(
        collection.table,
        "publishedAt",
        collection.apiId,
      );
      conditions.push(or(isNull(col), lte(col, new Date().toISOString()))!);
    }

    if (!filters) return conditions.length ? and(...conditions) : undefined;

    for (const [field, condition] of Object.entries(filters)) {
      if (!collection.filterable.includes(field)) {
        throw new QueryError(
          `Field "${field}" is not filterable on ${collection.apiId}`,
          "UNKNOWN_FIELD",
        );
      }
      const col = requireColumn(collection.table, field, collection.apiId);

      // Bare value is sugar for $eq.
      if (
        condition === null ||
        typeof condition !== "object" ||
        Array.isArray(condition)
      ) {
        conditions.push(eq(col, condition as never));
        continue;
      }

      for (const [op, raw] of Object.entries(condition)) {
        conditions.push(this.buildCondition(col, op, raw));
      }
    }

    return conditions.length ? and(...conditions) : undefined;
  }

  private buildCondition(col: SQLiteColumnLike, op: string, raw: unknown): SQL {
    switch (op) {
      case "$eq":
        return eq(col, raw as never);
      case "$ne":
        return ne(col, raw as never);
      case "$lt":
        return lt(col, raw as never);
      case "$lte":
        return lte(col, raw as never);
      case "$gt":
        return gt(col, raw as never);
      case "$gte":
        return gte(col, raw as never);
      case "$in":
        return inArray(col, this.toArray(raw) as never[]);
      case "$notIn":
        return notInArray(col, this.toArray(raw) as never[]);
      case "$contains":
        // Escape LIKE wildcards in user input so a `%` in a search term
        // is matched literally instead of turning into "match anything".
        return like(col, `%${this.escapeLike(String(raw))}%`);
      case "$null":
        return raw === false ? isNotNull(col) : isNull(col);
      case "$notNull":
        return raw === false ? isNull(col) : isNotNull(col);
      default:
        throw new QueryError(`Unknown operator "${op}"`, "UNKNOWN_OPERATOR");
    }
  }

  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
  }

  private toArray(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (raw == null) return [];
    return [raw];
  }

  private buildOrderBy(collection: CollectionDef, sort?: string | string[]) {
    if (!sort) return [];
    const specs = Array.isArray(sort) ? sort : [sort];
    return specs.map((spec) => {
      const descending = spec.startsWith("-");
      const field = descending ? spec.slice(1) : spec;
      if (!collection.filterable.includes(field)) {
        throw new QueryError(
          `Field "${field}" is not sortable on ${collection.apiId}`,
          "INVALID_SORT",
        );
      }
      const col = requireColumn(collection.table, field, collection.apiId);
      return descending ? desc(col) : asc(col);
    });
  }

  private validateLocale(locale?: string): string | undefined {
    if (!locale) return undefined;
    if (!this.opts.supportedLocales.includes(locale)) {
      throw new QueryError(
        `Unsupported locale "${locale}". Supported: ${this.opts.supportedLocales.join(", ")}`,
        "INVALID_LOCALE",
      );
    }
    return locale;
  }

  /**
   * Depth is capped so a crafted `?populate=a.b.c.d.e…` can't fan out
   * into an unbounded number of round trips. Contentful caps include
   * at 10; Hygraph uses a complexity budget; #68 §D asks for 2–3.
   */
  private assertDepth(
    populate: Record<string, PopulateSpec> | undefined,
    depth: number,
  ): void {
    if (!populate) return;
    if (depth > MAX_POPULATE_DEPTH) {
      throw new QueryError(
        `Populate depth exceeds maximum of ${MAX_POPULATE_DEPTH}`,
        "DEPTH_EXCEEDED",
      );
    }
    for (const spec of Object.values(populate)) {
      if (spec && typeof spec === "object" && spec.populate) {
        this.assertDepth(spec.populate, depth + 1);
      }
    }
  }

  private async tracked<T>(run: () => Promise<T>): Promise<T> {
    this.queryCount++;
    return run();
  }
}
