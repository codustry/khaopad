/**
 * Query-layer collection registry — Phase 1 (#68).
 *
 * Describes the CURRENT hand-written schema to the generic query
 * engine, so `find()`/`populate` work over today's tables with **no
 * migration and no data movement**. This is deliberately a code-level
 * registry, not a DB-stored one: Phase 1's whole premise is "generic
 * query layer over the existing schema."
 *
 * When Phase 2's DB-stored collection registry lands, it produces the
 * same `CollectionDef` shape at runtime and the engine below is reused
 * unchanged. That is the point of splitting the phases — the query
 * engine never learns whether its collections came from code or rows.
 *
 * ## What a relation is here
 *
 * Three kinds, matching what the current schema actually uses:
 *
 * - `manyToOne`  — an FK column on this table (articles.category_id)
 * - `manyToMany` — a join table (article_tags)
 * - `localizations` — the repo's base-row + sibling-`_localizations`
 *   convention. Modelled as a relation rather than special-cased so
 *   `populate` and `fields` treat it uniformly.
 *
 * Every one resolves by **batched `inArray` over collected parent
 * ids**, never per row. See engine.ts.
 */
import * as schema from "../schema";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/** How a relation is physically stored in the current schema. */
export type RelationDef =
  | {
      kind: "manyToOne";
      /** Column on THIS table holding the target id. */
      localKey: string;
      /** Collection apiId being pointed at. */
      target: string;
      /** Column on the target table the localKey matches (default "id"). */
      targetKey?: string;
    }
  | {
      kind: "manyToMany";
      /** Join table, e.g. article_tags. */
      through: SQLiteTable;
      /** Join-table column pointing back at this collection. */
      throughLocalKey: string;
      /** Join-table column pointing at the target collection. */
      throughTargetKey: string;
      target: string;
    }
  | {
      kind: "localizations";
      /** The sibling `_localizations` table. */
      table: SQLiteTable;
      /** Column on that table pointing back at the base row. */
      foreignKey: string;
      /**
       * Columns that carry translated text. Everything else on the
       * localization row (id, the FK, locale) is structural.
       */
      fields: readonly string[];
    };

export interface CollectionDef {
  /** Stable public name used in API params: `?populate=category`. */
  apiId: string;
  table: SQLiteTable;
  /** Primary key column name. Every current table uses "id". */
  primaryKey: string;
  /**
   * Columns safe to expose through the public API. Anything absent is
   * unreachable via `fields` or a populate leaf — an allowlist, so a
   * column added later is private until someone opts it in.
   */
  selectable: readonly string[];
  /** Columns permitted in `filters` / `sort`. Subset of selectable. */
  filterable: readonly string[];
  relations: Record<string, RelationDef>;
}

/**
 * The registry itself. Only content collections are listed — users,
 * sessions, accounts, api_keys and the rest of the auth/ops tables are
 * intentionally absent so no populate path can ever reach them.
 */
export const COLLECTIONS: Record<string, CollectionDef> = {
  articles: {
    apiId: "articles",
    table: schema.articles,
    primaryKey: "id",
    selectable: [
      "id",
      "slug",
      "coverMediaId",
      "categoryId",
      "authorId",
      "status",
      "publishedAt",
      "commentsMode",
      "createdAt",
      "updatedAt",
    ],
    filterable: [
      "id",
      "slug",
      "categoryId",
      "authorId",
      "status",
      "publishedAt",
      "createdAt",
      "updatedAt",
    ],
    relations: {
      category: {
        kind: "manyToOne",
        localKey: "categoryId",
        target: "categories",
      },
      coverMedia: {
        kind: "manyToOne",
        localKey: "coverMediaId",
        target: "media",
      },
      tags: {
        kind: "manyToMany",
        through: schema.articleTags,
        throughLocalKey: "articleId",
        throughTargetKey: "tagId",
        target: "tags",
      },
      localizations: {
        kind: "localizations",
        table: schema.articleLocalizations,
        foreignKey: "articleId",
        fields: ["title", "excerpt", "body", "seoTitle", "seoDescription"],
      },
    },
  },

  categories: {
    apiId: "categories",
    table: schema.categories,
    primaryKey: "id",
    selectable: ["id", "slug", "createdAt"],
    filterable: ["id", "slug", "createdAt"],
    relations: {
      localizations: {
        kind: "localizations",
        table: schema.categoryLocalizations,
        foreignKey: "categoryId",
        fields: ["name", "description"],
      },
    },
  },

  tags: {
    apiId: "tags",
    table: schema.tags,
    primaryKey: "id",
    selectable: ["id", "slug", "createdAt"],
    filterable: ["id", "slug", "createdAt"],
    relations: {
      localizations: {
        kind: "localizations",
        table: schema.tagLocalizations,
        foreignKey: "tagId",
        fields: ["name"],
      },
    },
  },

  pages: {
    apiId: "pages",
    table: schema.pages,
    primaryKey: "id",
    selectable: [
      "id",
      "slug",
      "parentId",
      "template",
      "status",
      "publishedAt",
      "createdAt",
      "updatedAt",
    ],
    filterable: [
      "id",
      "slug",
      "parentId",
      "template",
      "status",
      "publishedAt",
      "createdAt",
      "updatedAt",
    ],
    relations: {
      // Self-referential. `pages.parent_id` is plain text with no
      // .references() in the current schema (#68 §1.1 flags this) —
      // populate still resolves it, it just isn't FK-enforced at the
      // DB level.
      parent: {
        kind: "manyToOne",
        localKey: "parentId",
        target: "pages",
      },
      localizations: {
        kind: "localizations",
        table: schema.pageLocalizations,
        foreignKey: "pageId",
        fields: ["title", "body", "seoTitle", "seoDescription"],
      },
    },
  },

  media: {
    apiId: "media",
    table: schema.media,
    primaryKey: "id",
    // No `localizations` relation: media alt text is a plain column in
    // the current schema, not a sibling table.
    // NOTE: the column is `altText`, not `alt` — `r2Key` and
    // `uploadedBy` are deliberately excluded. r2Key is an internal
    // storage path (media is served through /api/media/[id]) and
    // uploadedBy is a user id that public consumers have no business
    // seeing.
    selectable: [
      "id",
      "filename",
      "mimeType",
      "size",
      "width",
      "height",
      "altText",
      "folderId",
      "createdAt",
    ],
    filterable: ["id", "filename", "mimeType", "folderId", "createdAt"],
    relations: {},
  },
};

export function getCollection(apiId: string): CollectionDef | null {
  return Object.prototype.hasOwnProperty.call(COLLECTIONS, apiId)
    ? COLLECTIONS[apiId]
    : null;
}

export function listCollectionIds(): string[] {
  return Object.keys(COLLECTIONS);
}
