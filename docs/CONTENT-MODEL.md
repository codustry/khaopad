# Content Model

> **Status: draft** — the shape of content, the slug rules, and why the EN localization is special.

## The three moving parts

```
Article (shared across locales)
├── id (nanoid), slug (English ASCII, unique), status, coverMediaId, categoryId, authorId, publishedAt, createdAt, updatedAt
├── tags (many-to-many via article_tags)
└── localizations
    ├── en { title, excerpt, body (markdown), seoTitle?, seoDescription? }   ← required
    └── th { title, excerpt, body (markdown), seoTitle?, seoDescription? }   ← optional
```

- The **article** row holds what's common: the slug, the publish state, the relations.
- The **localization** row holds what differs per language: title and body.
- Media lives in its own table; articles point to a cover via `coverMediaId`. In-body images are markdown image tags referencing `/api/media/<id>`.

Categories and tags follow the same split: one row + per-locale localizations.

## Slug rules (the important bit)

> Slugs are **always English ASCII**, **shared across every locale**, and **auto-derived from the English title**.

Pattern: `^[a-z0-9]+(?:-[a-z0-9]+)*$` — lowercase, digits, hyphens, no leading/trailing hyphen.

This is enforced at three points:

1. **On create** — `D1ContentProvider.createArticle` requires `localizations.en.title`, runs it through `generateSlugFromTitle()` (NFKD-strip then collapse). Non-English titles produce an empty string → throws.
2. **On update** — if the admin renames the slug, it's re-normalized through `slugify()` before storing.
3. **At the type level** — `ArticleCreateInput.localizations` is typed as `{ en: LocalizedContent } & Partial<Record<Locale, LocalizedContent>>`, so TypeScript refuses a TH-only creation.

### Why shared, not per-locale?

The alternative — `/en/blog/hello-world` and `/th/blog/สวัสดี` — was considered and rejected:

- **SEO overlap.** Sharing a slug makes cross-locale `hreflang` trivial. The same article under different slugs in each language fragments link equity.
- **Editorial simplicity.** Writers translate the body; they don't re-slug. One slug, one URL shape, forever.
- **Thai doesn't transliterate cleanly.** There's no lossless romanization of Thai. Any auto-slug from a Thai title would be wrong. Demanding an English slug means the author is conscious about URL hygiene.
- **Per-locale URLs are the 5% case.** When someone really needs it (e.g. a fully localized campaign), they can add a redirect in `wrangler.toml` or a route alias. We don't bake it into the model.

### What happens with Thai-only authors?

They still have to enter an English slug (or English title). The editor UI will reflect this — an empty slug error with a message pointing at the English title field. This is a deliberate friction: the URL is a permanent artifact; burning five seconds to name it in English is worth it.

## The localization type

```ts
// src/lib/server/content/types.ts
export interface LocalizedContent {
  title: string;
  excerpt: string;
  body: string; // markdown
  seoTitle?: string;
  seoDescription?: string;
}

export interface ArticleRecord {
  // ... other fields
  localizations: Partial<Record<Locale, LocalizedContent>>;
}

export interface ArticleCreateInput {
  slug?: string; // optional — derived from en.title if omitted
  localizations: { en: LocalizedContent } & Partial<
    Record<Locale, LocalizedContent>
  >;
  // ...
}
```

Note that `ArticleRecord.localizations` is `Partial<...>` (a DB read might come back with only EN), while `ArticleCreateInput.localizations` enforces EN exists. This is the TypeScript equivalent of "permissive on reads, strict on writes."

## How the public blog resolves a locale

On `www.*/[locale]/blog/[slug]`:

```ts
// +page.server.ts
const article = await locals.content.getArticleBySlug(params.slug);
const localization = article.localizations[locale] ?? article.localizations.en;
if (!localization) throw error(404);
```

**English is the canonical fallback.** If a reader visits `/th/blog/hello-world` and no Thai localization exists, we serve the English body rather than 404. The page still returns the Thai locale in `<html lang>` so Paraglide UI chrome stays in Thai; only the article body is in English. This is deliberate: an article without a translation still has SEO value and is better than a missing page.

## D1 schema (key tables)

```
users (id, name, email, email_verified, role, created_at, updated_at)
articles (id, slug UNIQUE, cover_media_id?, category_id?, author_id, status, published_at?, created_at, updated_at)
article_localizations (id, article_id, locale, title, excerpt?, body, seo_title?, seo_description?)
article_tags (article_id, tag_id)  — composite PK
categories (id, slug UNIQUE, created_at)
category_localizations (id, category_id, locale, name, description?)
tags (id, slug UNIQUE, created_at)
tag_localizations (id, tag_id, locale, name)
media (id, filename, original_name, mime_type, size, width?, height?, uploaded_by, created_at)
site_settings (key PK, value, updated_at)
audit_log (id, user_id?, action, entity_type, entity_id, metadata?, created_at)
```

All IDs are `nanoid()`. All timestamps are ISO-8601 strings (SQLite has no real datetime type and storing strings lets us reason about them the same way in Drizzle and in seed SQL).

The canonical migration is `drizzle/0000_nice_thor.sql`, generated from `src/lib/server/content/schema.ts`. Schema changes: edit the schema, then `pnpm db:generate` to produce the next migration.

## The ContentProvider interface

Every route uses `locals.content` (type: `ContentProvider`) — never Drizzle, never D1 directly. The full interface:

```ts
interface ContentProvider {
  // Articles
  getArticle(id): Promise<ArticleRecord | null>;
  getArticleBySlug(slug): Promise<ArticleRecord | null>;
  listArticles(filter?): Promise<PaginatedResult<ArticleRecord>>;
  createArticle(data): Promise<ArticleRecord>;
  updateArticle(id, data): Promise<ArticleRecord>;
  deleteArticle(id): Promise<void>;

  // Categories, Tags (same pattern)
  // Site settings
  getSettings(): Promise<SiteSettings>;
  updateSettings(data): Promise<SiteSettings>;
}
```

One shipped implementation:

- **`D1ContentProvider`** — Drizzle over D1. Wired directly by `createContentProvider` in `src/lib/server/content/index.ts`.

### Why abstract at all if there's only one provider?

The interface is cheap to maintain (one extra method call per query) and earns its keep in two places:

1. **Testing.** An in-memory `ContentProvider` lets unit tests bypass Miniflare entirely.
2. **Future flexibility.** If a real demand for an alternate backend appears, the seam is already there — call sites won't need to change.

What we explicitly do **not** do: ship a second active backend. An earlier draft of this project envisioned a GitHub-backed provider as a "Mode B" alongside D1; it was removed because it doubled the bug surface, broke down at media (R2 isn't versioned), and confused the product pitch. See [the v1.1 release notes](./MILESTONES.md) for the rationale.

---

_Last touched: 2026-04-18 · Files: `src/lib/server/content/types.ts`, `src/lib/server/content/schema.ts`, `src/lib/server/content/providers/d1.ts`, `src/lib/utils.ts`, `drizzle/0000_nice_thor.sql`._
