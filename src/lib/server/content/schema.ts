import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// ─── Users & Auth (Better Auth managed) ──────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  role: text("role", { enum: ["super_admin", "admin", "editor", "author"] })
    .notNull()
    .default("author"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: text("access_token_expires_at"),
  refreshTokenExpiresAt: text("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Content ─────────────────────────────────────────────

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const categoryLocalizations = sqliteTable("category_localizations", {
  id: text("id").primaryKey(),
  categoryId: text("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  locale: text("locale", { enum: ["th", "en"] }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
});

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const tagLocalizations = sqliteTable("tag_localizations", {
  id: text("id").primaryKey(),
  tagId: text("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
  locale: text("locale", { enum: ["th", "en"] }).notNull(),
  name: text("name").notNull(),
});

export const articles = sqliteTable("articles", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  coverMediaId: text("cover_media_id").references(() => media.id, {
    onDelete: "set null",
  }),
  categoryId: text("category_id").references(() => categories.id, {
    onDelete: "set null",
  }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id),
  status: text("status", { enum: ["draft", "published", "archived"] })
    .notNull()
    .default("draft"),
  publishedAt: text("published_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const articleLocalizations = sqliteTable("article_localizations", {
  id: text("id").primaryKey(),
  articleId: text("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),
  locale: text("locale", { enum: ["th", "en"] }).notNull(),
  title: text("title").notNull(),
  excerpt: text("excerpt"),
  body: text("body").notNull(),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
});

export const articleTags = sqliteTable(
  "article_tags",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.articleId, table.tagId] }),
  }),
);

// ─── Media ───────────────────────────────────────────────

export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  r2Key: text("r2_key").notNull().unique(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  width: integer("width"),
  height: integer("height"),
  altText: text("alt_text"),
  /**
   * Parent folder (v1.7). Null = root. ON DELETE SET NULL so deleting
   * a folder doesn't take its assets with it — they fall back to the
   * root and the editor can reorganize from there.
   */
  folderId: text("folder_id"),
  uploadedBy: text("uploaded_by").references(() => users.id),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Media folders (v1.7) ────────────────────────────────
// Self-referential tree of folders. Backwards-compatible: existing
// rows on `media` keep folderId = null and live at the root. The
// CMS /cms/media page renders a left tree with folder CRUD.

export const mediaFolders = sqliteTable("media_folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Site Settings ───────────────────────────────────────

export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON string
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Audit Trail ─────────────────────────────────────────

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  metadata: text("metadata"), // JSON
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Article versions ────────────────────────────────────
// Per-locale snapshot of article content at the moment of a change.
// One row per save. The live data lives in `article_localizations`;
// this table records the history. Queryable timeline + diff target.

export const articleVersions = sqliteTable("article_versions", {
  id: text("id").primaryKey(),
  articleId: text("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),
  locale: text("locale", { enum: ["th", "en"] }).notNull(),
  /**
   * Monotonic per (articleId, locale). The first save snapshot is
   * version 1, second is 2, etc. Computed at write time by counting
   * existing rows + 1 — racy under high concurrency but acceptable for
   * a single-editor CMS.
   */
  version: integer("version").notNull(),
  title: text("title").notNull(),
  excerpt: text("excerpt"),
  body: text("body").notNull(),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  /** The user who saved this version. Null when the version was
   *  written by a backfill script. */
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Slug redirects ──────────────────────────────────────
// When an admin renames an article slug, write a redirect row so the
// old URL keeps working with a 301. Permanent redirects (back-link
// preservation), not soft moves. The public /blog/[slug] route checks
// here before throwing 404.

export const slugRedirects = sqliteTable("slug_redirects", {
  id: text("id").primaryKey(),
  oldSlug: text("old_slug").notNull().unique(),
  newSlug: text("new_slug").notNull(),
  /** The article that owns the new slug. Cascades on delete so we
   *  don't keep redirects to dead articles. */
  articleId: text("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Invitations ─────────────────────────────────────────
// One-shot signup links generated by an admin. The URL itself is the
// bearer credential — the token is a random base64 string stored
// plain-text. `acceptedAt` non-null means the link has been burned.

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "editor", "author"] }).notNull(),
  token: text("token").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  acceptedAt: text("accepted_at"),
  acceptedUserId: text("accepted_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Pages (v1.7) ────────────────────────────────────────
// Static pages distinct from articles: about, contact, privacy, etc.
// Routed at (www)/[locale]/[...slug] catch-all so nested slugs like
// /about/team work. Reuses the markdown editor + per-locale content
// model. SEO fields piggyback the v1.6 <Seo> machinery.

export const pages = sqliteTable("pages", {
  id: text("id").primaryKey(),
  /** ASCII-only, may include nested segments (a-z0-9- separated by /). */
  slug: text("slug").notNull().unique(),
  /** Self-reference for tree views in the CMS. Null = top-level. */
  parentId: text("parent_id"),
  /** Soft layout hint (default | landing | legal). The public route
   *  uses this to pick a wrapper component. */
  template: text("template", { enum: ["default", "landing", "legal"] })
    .notNull()
    .$defaultFn(() => "default"),
  status: text("status", { enum: ["draft", "published"] })
    .notNull()
    .$defaultFn(() => "draft"),
  /** When set + status='published' + in the future, the page is
   *  scheduled — see scheduled-publishing pattern from v1.3. */
  publishedAt: text("published_at"),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const pageLocalizations = sqliteTable("page_localizations", {
  id: text("id").primaryKey(),
  pageId: text("page_id")
    .notNull()
    .references(() => pages.id, { onDelete: "cascade" }),
  locale: text("locale", { enum: ["th", "en"] }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
});

// ─── Navigation (v1.7) ───────────────────────────────────
// Site-wide menu manager. Two stock menus by default (`primary`,
// `footer`); admins can add more. Each menu is an ordered tree of
// items pointing at internal entities or custom URLs.

export const navigationMenus = sqliteTable("navigation_menus", {
  id: text("id").primaryKey(),
  /** Stable lookup key: 'primary', 'footer', etc. Used by the layout
   *  hook to fetch the right menu. */
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const navigationItems = sqliteTable("navigation_items", {
  id: text("id").primaryKey(),
  menuId: text("menu_id")
    .notNull()
    .references(() => navigationMenus.id, { onDelete: "cascade" }),
  /** Self-reference for nested menus. Null = top-level. */
  parentId: text("parent_id"),
  /** Position in the parent's children — lower comes first. */
  position: integer("position").notNull().$defaultFn(() => 0),
  /** Per-locale label JSON (`{"en":"About","th":"เกี่ยวกับ"}`). */
  labels: text("labels").notNull(),
  /** Either an internal target (`article:<id>`, `category:<id>`,
   *  `tag:<id>`, `page:<id>`) or 'custom'. The CMS UI splits the form
   *  by kind. */
  kind: text("kind", {
    enum: ["article", "category", "tag", "page", "custom"],
  }).notNull(),
  /** When kind != 'custom', the entity id. Otherwise null. */
  targetId: text("target_id"),
  /** When kind = 'custom', the literal URL. Otherwise null. */
  customUrl: text("custom_url"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Content blocks (v1.7) ───────────────────────────────
// Reusable snippets injected into article/page bodies via a
// `{{block:my-key}}` shortcode. Per-locale body so a CTA block can be
// translated. Authored as markdown; the renderer expands the
// shortcode server-side before passing to `marked`.

export const contentBlocks = sqliteTable("content_blocks", {
  id: text("id").primaryKey(),
  /** Lookup key. ASCII-only (a-z0-9-). Referenced from the shortcode. */
  key: text("key").notNull().unique(),
  /** Human label so editors can find blocks in the picker. */
  label: text("label").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const contentBlockLocalizations = sqliteTable(
  "content_block_localizations",
  {
    id: text("id").primaryKey(),
    blockId: text("block_id")
      .notNull()
      .references(() => contentBlocks.id, { onDelete: "cascade" }),
    locale: text("locale", { enum: ["th", "en"] }).notNull(),
    body: text("body").notNull(),
  },
);
