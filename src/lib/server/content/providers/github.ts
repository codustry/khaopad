import type {
  ContentProvider,
  ArticleRecord,
  ArticleCreateInput,
  ArticleUpdateInput,
  ArticleFilter,
  PaginatedResult,
  CategoryRecord,
  TagRecord,
  SiteSettings,
} from "../types";

/**
 * GitHub-backed content provider.
 *
 * Stores content as markdown/json files in the repository.
 * Uses GitHub Contents API for reads/writes and KV for caching.
 *
 * TODO: Implement in v1.1
 *
 * File structure:
 * content/
 * ├── articles/{slug}/
 * │   ├── meta.json    (shared metadata)
 * │   ├── th.md        (Thai content with frontmatter)
 * │   └── en.md        (English content with frontmatter)
 * ├── categories/{id}.json
 * ├── tags/{id}.json
 * ├── media/registry.json
 * └── settings.json
 */

export interface GitHubProviderConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  kv: KVNamespace;
}

export class GitHubContentProvider implements ContentProvider {
  constructor(private config: GitHubProviderConfig) {}

  // ─── Articles ──────────────────────────────────────────

  async getArticle(_id: string): Promise<ArticleRecord | null> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async getArticleBySlug(_slug: string): Promise<ArticleRecord | null> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async listArticles(
    _filter?: ArticleFilter,
  ): Promise<PaginatedResult<ArticleRecord>> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async createArticle(_data: ArticleCreateInput): Promise<ArticleRecord> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async updateArticle(
    _id: string,
    _data: ArticleUpdateInput,
  ): Promise<ArticleRecord> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async deleteArticle(_id: string): Promise<void> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  // ─── Categories ────────────────────────────────────────

  async getCategory(_id: string): Promise<CategoryRecord | null> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async listCategories(): Promise<CategoryRecord[]> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async createCategory(_data: {
    slug: string;
    localizations: CategoryRecord["localizations"];
  }): Promise<CategoryRecord> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async updateCategory(
    _id: string,
    _data: Partial<Pick<CategoryRecord, "slug" | "localizations">>,
  ): Promise<CategoryRecord> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async deleteCategory(_id: string): Promise<void> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  // ─── Tags ──────────────────────────────────────────────

  async getTag(_id: string): Promise<TagRecord | null> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async listTags(): Promise<TagRecord[]> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async createTag(_data: {
    slug: string;
    localizations: TagRecord["localizations"];
  }): Promise<TagRecord> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async deleteTag(_id: string): Promise<void> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  // ─── Site Settings ─────────────────────────────────────

  async getSettings(): Promise<SiteSettings> {
    throw new Error("GitHubContentProvider not yet implemented");
  }

  async updateSettings(_data: Partial<SiteSettings>): Promise<SiteSettings> {
    throw new Error("GitHubContentProvider not yet implemented");
  }
}
