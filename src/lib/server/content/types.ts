// ─── Locale ──────────────────────────────────────────────
export type Locale = "en" | "th";

/** Default canonical locale for slugs and URL fallbacks. */
export const DEFAULT_LOCALE: Locale = "en";

// ─── Localized content (per language) ────────────────────
export interface LocalizedContent {
  title: string;
  excerpt: string;
  body: string; // markdown
  seoTitle?: string;
  seoDescription?: string;
}

// ─── Articles ────────────────────────────────────────────
export interface ArticleRecord {
  id: string;
  /**
   * URL slug. Always English (ASCII), shared across every locale.
   * Auto-generated from the English title by `slugify()` if the caller does not
   * supply one explicitly. Must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`.
   */
  slug: string;
  coverMediaId: string | null;
  categoryId: string | null;
  tagIds: string[];
  authorId: string;
  status: "draft" | "published" | "archived";
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Per-locale text. The English (`en`) entry is **required** when creating an
   * article because the slug is derived from its title.
   */
  localizations: Partial<Record<Locale, LocalizedContent>>;
}

export interface ArticleCreateInput {
  /**
   * Optional explicit slug. If omitted, the provider derives one from
   * `localizations.en.title` via `slugify()`. Must be ASCII (`a-z0-9-`).
   */
  slug?: string;
  coverMediaId?: string;
  categoryId?: string;
  tagIds?: string[];
  authorId: string;
  status?: ArticleRecord["status"];
  publishedAt?: string;
  /** Must include `en` so the slug can be derived from the English title. */
  localizations: { en: LocalizedContent } & Partial<
    Record<Locale, LocalizedContent>
  >;
}

export interface ArticleUpdateInput {
  /**
   * Slugs are immutable across locales but may be re-keyed by an admin (e.g. fixing a typo).
   * Other languages always reuse the same slug — there is no per-locale slug.
   */
  slug?: string;
  coverMediaId?: string | null;
  categoryId?: string | null;
  tagIds?: string[];
  status?: ArticleRecord["status"];
  publishedAt?: string | null;
  localizations?: Partial<Record<Locale, LocalizedContent>>;
}

export interface ArticleFilter {
  status?: ArticleRecord["status"];
  categoryId?: string;
  tagId?: string;
  authorId?: string;
  locale?: Locale;
  search?: string;
  page?: number;
  limit?: number;
  /**
   * When true, the result excludes articles whose `publishedAt` is in
   * the future (scheduled posts). Always pass `true` from public reads.
   * Defaults to `false` so the CMS can show every article regardless of
   * schedule.
   */
  onlyPublished?: boolean;
}

// ─── Categories ──────────────────────────────────────────
export interface CategoryRecord {
  id: string;
  slug: string;
  createdAt: string;
  localizations: Partial<
    Record<Locale, { name: string; description?: string }>
  >;
}

// ─── Tags ────────────────────────────────────────────────
export interface TagRecord {
  id: string;
  slug: string;
  createdAt: string;
  localizations: Partial<Record<Locale, { name: string }>>;
}

// ─── Site Settings ───────────────────────────────────────
export interface SiteSettings {
  siteName: string;
  defaultLocale: Locale;
  supportedLocales: Locale[];
  cdnBaseUrl?: string;
  [key: string]: unknown;
}

// ─── Pagination ──────────────────────────────────────────
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Content Provider Interface ──────────────────────────
export interface ContentProvider {
  // Articles
  getArticle(id: string): Promise<ArticleRecord | null>;
  getArticleBySlug(slug: string): Promise<ArticleRecord | null>;
  listArticles(filter?: ArticleFilter): Promise<PaginatedResult<ArticleRecord>>;
  createArticle(data: ArticleCreateInput): Promise<ArticleRecord>;
  updateArticle(id: string, data: ArticleUpdateInput): Promise<ArticleRecord>;
  deleteArticle(id: string): Promise<void>;

  // Categories
  getCategory(id: string): Promise<CategoryRecord | null>;
  listCategories(): Promise<CategoryRecord[]>;
  createCategory(data: {
    slug: string;
    localizations: CategoryRecord["localizations"];
  }): Promise<CategoryRecord>;
  updateCategory(
    id: string,
    data: Partial<Pick<CategoryRecord, "slug" | "localizations">>,
  ): Promise<CategoryRecord>;
  deleteCategory(id: string): Promise<void>;

  // Tags
  getTag(id: string): Promise<TagRecord | null>;
  listTags(): Promise<TagRecord[]>;
  createTag(data: {
    slug: string;
    localizations: TagRecord["localizations"];
  }): Promise<TagRecord>;
  updateTag(
    id: string,
    data: Partial<Pick<TagRecord, "slug" | "localizations">>,
  ): Promise<TagRecord>;
  deleteTag(id: string): Promise<void>;

  // Site Settings
  getSettings(): Promise<SiteSettings>;
  updateSettings(data: Partial<SiteSettings>): Promise<SiteSettings>;
}
