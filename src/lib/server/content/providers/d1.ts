import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateSlugFromTitle, slugify } from "$lib/utils";
import * as schema from "../schema";
import type {
  ContentProvider,
  ArticleRecord,
  ArticleCreateInput,
  ArticleUpdateInput,
  ArticleFilter,
  ArticleVersionRecord,
  PaginatedResult,
  CategoryRecord,
  TagRecord,
  SearchHit,
  SearchOptions,
  SiteSettings,
  Locale,
  ContentBlockRecord,
} from "../types";

export class D1ContentProvider implements ContentProvider {
  private db: DrizzleD1Database<typeof schema>;

  constructor(d1: D1Database) {
    this.db = drizzle(d1, { schema });
  }

  // ─── Articles ──────────────────────────────────────────

  async getArticle(id: string): Promise<ArticleRecord | null> {
    const article = await this.db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, id))
      .get();

    if (!article) return null;
    return this.hydrateArticle(article);
  }

  async getArticleBySlug(slug: string): Promise<ArticleRecord | null> {
    const article = await this.db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.slug, slug))
      .get();

    if (!article) return null;
    return this.hydrateArticle(article);
  }

  async listArticles(
    filter: ArticleFilter = {},
  ): Promise<PaginatedResult<ArticleRecord>> {
    const {
      status,
      categoryId,
      tagId,
      authorId,
      search,
      page = 1,
      limit = 20,
      onlyPublished = false,
    } = filter;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (status) conditions.push(eq(schema.articles.status, status));
    if (categoryId) conditions.push(eq(schema.articles.categoryId, categoryId));
    if (authorId) conditions.push(eq(schema.articles.authorId, authorId));
    // Scheduled-publishing guard: hide articles whose publishedAt is in
    // the future. Articles with no publishedAt slip through (treated as
    // "publish immediately when status is 'published'"). Public callers
    // pass onlyPublished:true; CMS callers leave it false so editors can
    // see what's queued up.
    if (onlyPublished) {
      const nowIso = new Date().toISOString();
      conditions.push(
        or(
          isNull(schema.articles.publishedAt),
          lte(schema.articles.publishedAt, nowIso),
        )!,
      );
    }

    // Tag filter requires a subquery
    let articleIdsWithTag: string[] | undefined;
    if (tagId) {
      const tagRows = await this.db
        .select({ articleId: schema.articleTags.articleId })
        .from(schema.articleTags)
        .where(eq(schema.articleTags.tagId, tagId))
        .all();
      articleIdsWithTag = tagRows.map((r) => r.articleId);
      if (articleIdsWithTag.length === 0) {
        return { items: [], total: 0, page, limit };
      }
      conditions.push(inArray(schema.articles.id, articleIdsWithTag));
    }

    // Search in localizations
    let articleIdsWithSearch: string[] | undefined;
    if (search) {
      const searchRows = await this.db
        .select({ articleId: schema.articleLocalizations.articleId })
        .from(schema.articleLocalizations)
        .where(like(schema.articleLocalizations.title, `%${search}%`))
        .all();
      articleIdsWithSearch = [...new Set(searchRows.map((r) => r.articleId))];
      if (articleIdsWithSearch.length === 0) {
        return { items: [], total: 0, page, limit };
      }
      conditions.push(inArray(schema.articles.id, articleIdsWithSearch));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [articles, countResult] = await Promise.all([
      this.db
        .select()
        .from(schema.articles)
        .where(where)
        .orderBy(desc(schema.articles.createdAt))
        .limit(limit)
        .offset(offset)
        .all(),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.articles)
        .where(where)
        .get(),
    ]);

    const items = await Promise.all(
      articles.map((a) => this.hydrateArticle(a)),
    );

    return {
      items,
      total: countResult?.count ?? 0,
      page,
      limit,
    };
  }

  /**
   * FTS5-backed full-text search.
   *
   * The query string passes straight through to FTS5's `MATCH` operator
   * (so `"khao pad"` is a phrase, `khao*` is a prefix, `khao OR rice`
   * is a boolean), with one safety pass: bare strings get wrapped in
   * double quotes so unbalanced punctuation doesn't crash the query
   * parser. Power users can opt into the raw syntax by including a
   * double quote, parenthesis, or asterisk.
   *
   * The visibility filters (locale / onlyPublished / onlyPublishedStatus)
   * apply via a JOIN against `articles` so we don't leak draft/scheduled
   * content via search results.
   */
  async searchArticles(
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Heuristic: if the user typed something that looks like an FTS5
    // expression (quotes, parens, asterisk, AND/OR), pass it through;
    // otherwise wrap as a phrase to defang punctuation.
    const looksAdvanced = /["()*]|\b(AND|OR|NOT|NEAR)\b/.test(trimmed);
    const ftsQuery = looksAdvanced
      ? trimmed
      : `"${trimmed.replace(/"/g, '""')}"`;

    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    const localeFilter = opts.locale
      ? sql`AND fts.locale = ${opts.locale}`
      : sql``;
    const statusFilter = opts.onlyPublishedStatus
      ? sql`AND a.status = 'published'`
      : sql``;
    const scheduleFilter = opts.onlyPublished
      ? sql`AND (a.published_at IS NULL OR a.published_at <= ${new Date().toISOString()})`
      : sql``;

    // Drizzle doesn't model FTS5 virtual tables; the query is hand-
    // rolled with sql`` template tags. Returns the raw array; the
    // `unknown[]` cast is the standard escape hatch for D1 raw rows.
    type Row = {
      article_id: string;
      locale: string;
      title: string;
      snippet: string;
    };
    const rows = (await this.db.all(sql`
        SELECT
          fts.article_id,
          fts.locale,
          fts.title,
          snippet(articles_fts, 2, '<mark>', '</mark>', '…', 24) AS snippet
        FROM articles_fts AS fts
        JOIN articles AS a ON a.id = fts.article_id
        WHERE articles_fts MATCH ${ftsQuery}
        ${localeFilter}
        ${statusFilter}
        ${scheduleFilter}
        ORDER BY rank
        LIMIT ${limit}
      `)) as unknown as Row[];

    return rows.map((r) => ({
      articleId: r.article_id,
      locale: r.locale,
      title: r.title,
      snippet: r.snippet,
    }));
  }

  /**
   * Snapshot a localization into article_versions. Computes the next
   * monotonic version number per (articleId, locale).
   *
   * Best-effort: a failed snapshot must not break the primary
   * write the user actually cares about. Wrapped in try/catch and
   * swallowed.
   */
  private async snapshotVersion(args: {
    articleId: string;
    locale: Locale;
    title: string;
    excerpt: string | null;
    body: string;
    seoTitle?: string | null;
    seoDescription?: string | null;
    actorId?: string | null;
  }): Promise<void> {
    try {
      const last = await this.db
        .select({ version: schema.articleVersions.version })
        .from(schema.articleVersions)
        .where(
          and(
            eq(schema.articleVersions.articleId, args.articleId),
            eq(schema.articleVersions.locale, args.locale),
          ),
        )
        .orderBy(desc(schema.articleVersions.version))
        .limit(1)
        .get();
      const next = (last?.version ?? 0) + 1;

      await this.db.insert(schema.articleVersions).values({
        id: nanoid(),
        articleId: args.articleId,
        locale: args.locale,
        version: next,
        title: args.title,
        excerpt: args.excerpt,
        body: args.body,
        seoTitle: args.seoTitle ?? null,
        seoDescription: args.seoDescription ?? null,
        createdBy: args.actorId ?? null,
      });
    } catch {
      // Versioning is best-effort. Skipping a snapshot is acceptable;
      // breaking the save isn't.
    }
  }

  async listArticleVersions(
    articleId: string,
  ): Promise<ArticleVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.articleVersions)
      .where(eq(schema.articleVersions.articleId, articleId))
      .orderBy(desc(schema.articleVersions.createdAt))
      .all();
    return rows as ArticleVersionRecord[];
  }

  async getArticleVersion(
    versionId: string,
  ): Promise<ArticleVersionRecord | null> {
    const row = await this.db
      .select()
      .from(schema.articleVersions)
      .where(eq(schema.articleVersions.id, versionId))
      .get();
    return (row as ArticleVersionRecord | undefined) ?? null;
  }

  async createArticle(data: ArticleCreateInput): Promise<ArticleRecord> {
    const id = nanoid();
    const now = new Date().toISOString();

    // Slug is always English-only and shared across all locales.
    // If the caller didn't supply one, derive it from the English title.
    const englishTitle = data.localizations.en?.title;
    if (!englishTitle) {
      throw new Error(
        "localizations.en.title is required (slug is derived from it).",
      );
    }
    const slug = data.slug
      ? slugify(data.slug)
      : generateSlugFromTitle(englishTitle);
    if (!slug) {
      throw new Error("Slug must contain at least one ASCII letter or digit.");
    }

    await this.db.insert(schema.articles).values({
      id,
      slug,
      coverMediaId: data.coverMediaId ?? null,
      categoryId: data.categoryId ?? null,
      authorId: data.authorId,
      status: data.status ?? "draft",
      publishedAt: data.publishedAt ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // Insert localizations + snapshot v1 of each.
    for (const [locale, content] of Object.entries(data.localizations)) {
      if (!content) continue;
      await this.db.insert(schema.articleLocalizations).values({
        id: nanoid(),
        articleId: id,
        locale: locale as Locale,
        title: content.title,
        excerpt: content.excerpt ?? "",
        body: content.body,
        seoTitle: content.seoTitle,
        seoDescription: content.seoDescription,
      });
      await this.snapshotVersion({
        articleId: id,
        locale: locale as Locale,
        title: content.title,
        excerpt: content.excerpt ?? null,
        body: content.body,
        seoTitle: content.seoTitle ?? null,
        seoDescription: content.seoDescription ?? null,
        actorId: data.actorId ?? data.authorId,
      });
    }

    // Insert tags
    if (data.tagIds?.length) {
      for (const tagId of data.tagIds) {
        await this.db
          .insert(schema.articleTags)
          .values({ articleId: id, tagId });
      }
    }

    return (await this.getArticle(id))!;
  }

  async updateArticle(
    id: string,
    data: ArticleUpdateInput,
  ): Promise<ArticleRecord> {
    const now = new Date().toISOString();

    // Capture pre-update slug so we can write a redirect row if it changes.
    const before = data.slug !== undefined ? await this.getArticle(id) : null;

    const updateFields: Record<string, unknown> = { updatedAt: now };
    if (data.slug !== undefined) {
      const normalized = slugify(data.slug);
      if (!normalized) {
        throw new Error(
          "Slug must contain at least one ASCII letter or digit.",
        );
      }
      updateFields.slug = normalized;
      // If the slug actually changed, persist a redirect from the old
      // value so old URLs keep working with a 301. INSERT-OR-IGNORE on
      // the unique old_slug index — don't blow up if a chain forms
      // (a→b→c keeps both a→c and b→c).
      if (before && before.slug !== normalized) {
        try {
          await this.db.insert(schema.slugRedirects).values({
            id: nanoid(),
            oldSlug: before.slug,
            newSlug: normalized,
            articleId: id,
          });
          // Also re-point any redirects that previously targeted this
          // article's old slug. Without this, after a→b→c, a→b is
          // stale (b doesn't exist anymore).
          await this.db
            .update(schema.slugRedirects)
            .set({ newSlug: normalized })
            .where(eq(schema.slugRedirects.newSlug, before.slug));
        } catch {
          // best-effort: a duplicate (someone renamed back-and-forth)
          // is fine; the unique index just prevents double-write.
        }
      }
    }
    if (data.coverMediaId !== undefined)
      updateFields.coverMediaId = data.coverMediaId;
    if (data.categoryId !== undefined)
      updateFields.categoryId = data.categoryId;
    if (data.status !== undefined) updateFields.status = data.status;
    if (data.publishedAt !== undefined)
      updateFields.publishedAt = data.publishedAt;

    await this.db
      .update(schema.articles)
      .set(updateFields)
      .where(eq(schema.articles.id, id));

    // Update localizations
    if (data.localizations) {
      for (const [locale, content] of Object.entries(data.localizations)) {
        if (!content) continue;
        const existing = await this.db
          .select()
          .from(schema.articleLocalizations)
          .where(
            and(
              eq(schema.articleLocalizations.articleId, id),
              eq(schema.articleLocalizations.locale, locale as Locale),
            ),
          )
          .get();

        if (existing) {
          await this.db
            .update(schema.articleLocalizations)
            .set({
              title: content.title,
              excerpt: content.excerpt ?? "",
              body: content.body,
              seoTitle: content.seoTitle,
              seoDescription: content.seoDescription,
            })
            .where(eq(schema.articleLocalizations.id, existing.id));
        } else {
          await this.db.insert(schema.articleLocalizations).values({
            id: nanoid(),
            articleId: id,
            locale: locale as Locale,
            title: content.title,
            excerpt: content.excerpt ?? "",
            body: content.body,
            seoTitle: content.seoTitle,
            seoDescription: content.seoDescription,
          });
        }

        // Snapshot the new state. Versions only ever capture content
        // that's actually being saved, never an unchanged side of a
        // bilingual save.
        await this.snapshotVersion({
          articleId: id,
          locale: locale as Locale,
          title: content.title,
          excerpt: content.excerpt ?? null,
          body: content.body,
          seoTitle: content.seoTitle ?? null,
          seoDescription: content.seoDescription ?? null,
          actorId: data.actorId,
        });
      }
    }

    // Update tags
    if (data.tagIds !== undefined) {
      await this.db
        .delete(schema.articleTags)
        .where(eq(schema.articleTags.articleId, id));
      for (const tagId of data.tagIds) {
        await this.db
          .insert(schema.articleTags)
          .values({ articleId: id, tagId });
      }
    }

    return (await this.getArticle(id))!;
  }

  async deleteArticle(id: string): Promise<void> {
    await this.db.delete(schema.articles).where(eq(schema.articles.id, id));
  }

  private async hydrateArticle(
    article: typeof schema.articles.$inferSelect,
  ): Promise<ArticleRecord> {
    const [localizations, tagRows] = await Promise.all([
      this.db
        .select()
        .from(schema.articleLocalizations)
        .where(eq(schema.articleLocalizations.articleId, article.id))
        .all(),
      this.db
        .select()
        .from(schema.articleTags)
        .where(eq(schema.articleTags.articleId, article.id))
        .all(),
    ]);

    const locMap: ArticleRecord["localizations"] = {};
    for (const loc of localizations) {
      locMap[loc.locale as Locale] = {
        title: loc.title,
        excerpt: loc.excerpt ?? "",
        body: loc.body,
        seoTitle: loc.seoTitle ?? undefined,
        seoDescription: loc.seoDescription ?? undefined,
      };
    }

    return {
      id: article.id,
      slug: article.slug,
      coverMediaId: article.coverMediaId,
      categoryId: article.categoryId,
      status: article.status as ArticleRecord["status"],
      authorId: article.authorId,
      publishedAt: article.publishedAt,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
      tagIds: tagRows.map((r) => r.tagId),
      localizations: locMap,
    };
  }

  // ─── Categories ────────────────────────────────────────

  async getCategory(id: string): Promise<CategoryRecord | null> {
    const cat = await this.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, id))
      .get();

    if (!cat) return null;
    return this.hydrateCategory(cat);
  }

  async listCategories(): Promise<CategoryRecord[]> {
    const cats = await this.db.select().from(schema.categories).all();
    return Promise.all(cats.map((c) => this.hydrateCategory(c)));
  }

  async createCategory(data: {
    slug: string;
    localizations: CategoryRecord["localizations"];
  }): Promise<CategoryRecord> {
    const id = nanoid();
    await this.db.insert(schema.categories).values({
      id,
      slug: data.slug,
    });

    for (const [locale, content] of Object.entries(data.localizations)) {
      if (!content) continue;
      await this.db.insert(schema.categoryLocalizations).values({
        id: nanoid(),
        categoryId: id,
        locale: locale as Locale,
        name: content.name,
        description: content.description,
      });
    }

    return (await this.getCategory(id))!;
  }

  async updateCategory(
    id: string,
    data: Partial<Pick<CategoryRecord, "slug" | "localizations">>,
  ): Promise<CategoryRecord> {
    if (data.slug) {
      await this.db
        .update(schema.categories)
        .set({ slug: data.slug })
        .where(eq(schema.categories.id, id));
    }

    if (data.localizations) {
      for (const [locale, content] of Object.entries(data.localizations)) {
        if (!content) continue;
        const existing = await this.db
          .select()
          .from(schema.categoryLocalizations)
          .where(
            and(
              eq(schema.categoryLocalizations.categoryId, id),
              eq(schema.categoryLocalizations.locale, locale as Locale),
            ),
          )
          .get();

        if (existing) {
          await this.db
            .update(schema.categoryLocalizations)
            .set({ name: content.name, description: content.description })
            .where(eq(schema.categoryLocalizations.id, existing.id));
        } else {
          await this.db.insert(schema.categoryLocalizations).values({
            id: nanoid(),
            categoryId: id,
            locale: locale as Locale,
            name: content.name,
            description: content.description,
          });
        }
      }
    }

    return (await this.getCategory(id))!;
  }

  async deleteCategory(id: string): Promise<void> {
    await this.db.delete(schema.categories).where(eq(schema.categories.id, id));
  }

  private async hydrateCategory(
    cat: typeof schema.categories.$inferSelect,
  ): Promise<CategoryRecord> {
    const locs = await this.db
      .select()
      .from(schema.categoryLocalizations)
      .where(eq(schema.categoryLocalizations.categoryId, cat.id))
      .all();

    const locMap: CategoryRecord["localizations"] = {};
    for (const loc of locs) {
      locMap[loc.locale as Locale] = {
        name: loc.name,
        description: loc.description ?? undefined,
      };
    }

    return {
      id: cat.id,
      slug: cat.slug,
      createdAt: cat.createdAt,
      localizations: locMap,
    };
  }

  // ─── Tags ──────────────────────────────────────────────

  async getTag(id: string): Promise<TagRecord | null> {
    const tag = await this.db
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.id, id))
      .get();

    if (!tag) return null;
    return this.hydrateTag(tag);
  }

  async listTags(): Promise<TagRecord[]> {
    const allTags = await this.db.select().from(schema.tags).all();
    return Promise.all(allTags.map((t) => this.hydrateTag(t)));
  }

  async createTag(data: {
    slug: string;
    localizations: TagRecord["localizations"];
  }): Promise<TagRecord> {
    const id = nanoid();
    await this.db.insert(schema.tags).values({ id, slug: data.slug });

    for (const [locale, content] of Object.entries(data.localizations)) {
      if (!content) continue;
      await this.db.insert(schema.tagLocalizations).values({
        id: nanoid(),
        tagId: id,
        locale: locale as Locale,
        name: content.name,
      });
    }

    return (await this.getTag(id))!;
  }

  async updateTag(
    id: string,
    data: Partial<Pick<TagRecord, "slug" | "localizations">>,
  ): Promise<TagRecord> {
    if (data.slug) {
      await this.db
        .update(schema.tags)
        .set({ slug: data.slug })
        .where(eq(schema.tags.id, id));
    }

    if (data.localizations) {
      for (const [locale, content] of Object.entries(data.localizations)) {
        if (!content) continue;
        const existing = await this.db
          .select()
          .from(schema.tagLocalizations)
          .where(
            and(
              eq(schema.tagLocalizations.tagId, id),
              eq(schema.tagLocalizations.locale, locale as Locale),
            ),
          )
          .get();

        if (existing) {
          await this.db
            .update(schema.tagLocalizations)
            .set({ name: content.name })
            .where(eq(schema.tagLocalizations.id, existing.id));
        } else {
          await this.db.insert(schema.tagLocalizations).values({
            id: nanoid(),
            tagId: id,
            locale: locale as Locale,
            name: content.name,
          });
        }
      }
    }

    return (await this.getTag(id))!;
  }

  async deleteTag(id: string): Promise<void> {
    await this.db.delete(schema.tags).where(eq(schema.tags.id, id));
  }

  private async hydrateTag(
    tag: typeof schema.tags.$inferSelect,
  ): Promise<TagRecord> {
    const locs = await this.db
      .select()
      .from(schema.tagLocalizations)
      .where(eq(schema.tagLocalizations.tagId, tag.id))
      .all();

    const locMap: TagRecord["localizations"] = {};
    for (const loc of locs) {
      locMap[loc.locale as Locale] = { name: loc.name };
    }

    return {
      id: tag.id,
      slug: tag.slug,
      createdAt: tag.createdAt,
      localizations: locMap,
    };
  }

  // ─── Site Settings ─────────────────────────────────────

  async getSettings(): Promise<SiteSettings> {
    const rows = await this.db.select().from(schema.siteSettings).all();
    const settings: Record<string, unknown> = {
      siteName: "Khao Pad",
      defaultLocale: "en",
      supportedLocales: ["en", "th"],
    };

    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }

    return settings as SiteSettings;
  }

  async updateSettings(data: Partial<SiteSettings>): Promise<SiteSettings> {
    const now = new Date().toISOString();

    for (const [key, value] of Object.entries(data)) {
      // A `value` of `undefined` means "field omitted by the caller" — most
      // commonly an optional form field left blank. We treat that as a
      // delete so the row goes away (caller can re-create later) and the
      // NOT NULL `value` column never sees a null bind. `null` is treated
      // the same way for symmetry.
      if (value === undefined || value === null) {
        await this.db
          .delete(schema.siteSettings)
          .where(eq(schema.siteSettings.key, key));
        continue;
      }

      const serialized =
        typeof value === "string" ? value : JSON.stringify(value);
      const existing = await this.db
        .select()
        .from(schema.siteSettings)
        .where(eq(schema.siteSettings.key, key))
        .get();

      if (existing) {
        await this.db
          .update(schema.siteSettings)
          .set({ value: serialized, updatedAt: now })
          .where(eq(schema.siteSettings.key, key));
      } else {
        await this.db.insert(schema.siteSettings).values({
          key,
          value: serialized,
          updatedAt: now,
        });
      }
    }

    return this.getSettings();
  }

  // ─── Slug redirects (v1.6) ─────────────────────────────
  async resolveSlugRedirect(oldSlug: string): Promise<string | null> {
    const row = await this.db
      .select({ newSlug: schema.slugRedirects.newSlug })
      .from(schema.slugRedirects)
      .where(eq(schema.slugRedirects.oldSlug, oldSlug))
      .get();
    return row?.newSlug ?? null;
  }

  // ─── Content blocks (v1.7) ─────────────────────────────

  async listContentBlocks(): Promise<ContentBlockRecord[]> {
    const rows = await this.db.select().from(schema.contentBlocks).all();
    return Promise.all(rows.map((r) => this.hydrateContentBlock(r)));
  }

  async getContentBlock(id: string): Promise<ContentBlockRecord | null> {
    const row = await this.db
      .select()
      .from(schema.contentBlocks)
      .where(eq(schema.contentBlocks.id, id))
      .get();
    if (!row) return null;
    return this.hydrateContentBlock(row);
  }

  async getContentBlockByKey(
    key: string,
  ): Promise<ContentBlockRecord | null> {
    const row = await this.db
      .select()
      .from(schema.contentBlocks)
      .where(eq(schema.contentBlocks.key, key))
      .get();
    if (!row) return null;
    return this.hydrateContentBlock(row);
  }

  async createContentBlock(data: {
    key: string;
    label: string;
    localizations: ContentBlockRecord["localizations"];
  }): Promise<ContentBlockRecord> {
    const id = nanoid();
    const now = new Date().toISOString();
    await this.db.insert(schema.contentBlocks).values({
      id,
      key: data.key,
      label: data.label,
      createdAt: now,
      updatedAt: now,
    });
    for (const [locale, body] of Object.entries(data.localizations)) {
      if (!body) continue;
      await this.db.insert(schema.contentBlockLocalizations).values({
        id: nanoid(),
        blockId: id,
        locale: locale as Locale,
        body: body.body,
      });
    }
    return (await this.getContentBlock(id))!;
  }

  async updateContentBlock(
    id: string,
    data: Partial<{
      key: string;
      label: string;
      localizations: ContentBlockRecord["localizations"];
    }>,
  ): Promise<ContentBlockRecord> {
    const updateFields: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (data.key !== undefined) updateFields.key = data.key;
    if (data.label !== undefined) updateFields.label = data.label;
    await this.db
      .update(schema.contentBlocks)
      .set(updateFields)
      .where(eq(schema.contentBlocks.id, id));

    if (data.localizations) {
      for (const [locale, body] of Object.entries(data.localizations)) {
        if (!body) continue;
        const existing = await this.db
          .select()
          .from(schema.contentBlockLocalizations)
          .where(
            and(
              eq(schema.contentBlockLocalizations.blockId, id),
              eq(schema.contentBlockLocalizations.locale, locale as Locale),
            ),
          )
          .get();
        if (existing) {
          await this.db
            .update(schema.contentBlockLocalizations)
            .set({ body: body.body })
            .where(eq(schema.contentBlockLocalizations.id, existing.id));
        } else {
          await this.db.insert(schema.contentBlockLocalizations).values({
            id: nanoid(),
            blockId: id,
            locale: locale as Locale,
            body: body.body,
          });
        }
      }
    }
    return (await this.getContentBlock(id))!;
  }

  async deleteContentBlock(id: string): Promise<void> {
    await this.db
      .delete(schema.contentBlocks)
      .where(eq(schema.contentBlocks.id, id));
  }

  private async hydrateContentBlock(
    block: typeof schema.contentBlocks.$inferSelect,
  ): Promise<ContentBlockRecord> {
    const locs = await this.db
      .select()
      .from(schema.contentBlockLocalizations)
      .where(eq(schema.contentBlockLocalizations.blockId, block.id))
      .all();
    const localizations: ContentBlockRecord["localizations"] = {};
    for (const loc of locs) {
      localizations[loc.locale as Locale] = { body: loc.body };
    }
    return {
      id: block.id,
      key: block.key,
      label: block.label,
      createdAt: block.createdAt,
      updatedAt: block.updatedAt,
      localizations,
    };
  }
}
