// ─── Locale ──────────────────────────────────────────────
export type Locale = "th" | "en";

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
  slug: string;
  coverMediaId: string | null;
  categoryId: string | null;
  tagIds: string[];
  authorId: string;
  status: "draft" | "published" | "archived";
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  localizations: Partial<Record<Locale, LocalizedContent>>;
}

export interface ArticleCreateInput {
  slug: string;
  coverMediaId?: string;
  categoryId?: string;
  tagIds?: string[];
  authorId: string;
  status?: ArticleRecord["status"];
  publishedAt?: string;
  localizations: Partial<Record<Locale, LocalizedContent>>;
}

export interface ArticleUpdateInput {
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
  deleteTag(id: string): Promise<void>;

  // Site Settings
  getSettings(): Promise<SiteSettings>;
  updateSettings(data: Partial<SiteSettings>): Promise<SiteSettings>;
}
