# Milestones

Tracks what shipped in each milestone and what's pending. Updated every time a milestone (or release) PR merges into `main`.

## Shipped

### M1 — Scaffold & architecture

- SvelteKit 2 + Svelte 5 + Tailwind 4 + Cloudflare adapter.
- Route groups `(www)` / `(cms)` with subdomain routing in `hooks.server.ts`.
- Paraglide JS 2 wired up for UI strings (EN default, TH secondary).
- `ContentProvider` interface with D1 implementation.
- Platform guard (`locals.platform.env`) so local `pnpm dev` degrades gracefully without bindings.

### M2 — D1 migrations, seed, first-run setup

- Drizzle schema + migrations for articles, localizations, categories, tags, media, users/sessions.
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:migrate:remote` workflow.
- Seed script (`scripts/seed.ts`) with idempotent demo content.
- `pnpm setup` first-run wizard that prints post-install next steps.

### M3 — Auth & CMS article CRUD

- Better Auth (email/password, D1-backed sessions) with role hierarchy (super_admin > admin > editor > author).
- First-admin signup — `/cms/signup` only accepts the very first user, after which it 403s.
- CMS list/create/edit/delete pages for articles with per-locale (EN required, TH optional) forms.
- Permission helpers: `canEditArticle`, `canPublish`, `canDeleteArticle`.
- EN-only ASCII slugs shared across locales, auto-derived from EN title.

### M4 — Media library

- R2-backed upload/delete API (`/api/media/*`).
- CMS `/cms/media` page with drag-upload, alt-text, copy-ID, delete.
- `coverMediaId` picker in the article form with preview.
- `docs/MIGRATING.md` — guide for folding an existing SvelteKit project into Khao Pad.

### M5 — Categories & tags

- CMS `/cms/categories` and `/cms/tags` pages: list/create/edit/delete with inline editor and EN/TH localizations.
- `canManageTaxonomy` permission gate (editor+ can write, anyone authenticated can read).
- Category `<select>` + tag multi-checkbox picker inside the article form; persisted via `categoryId` / `tagIds` on `ArticleUpdateInput`.
- Public blog filters: `/blog?category=<slug>` and `/blog?tag=<slug>` with clear-filter banner and clickable taxonomy chips on each article card.
- Article cards on `/blog` now surface their category + tags.
- GitHub Actions `ci.yml` runs `svelte-check`, `eslint`, `prettier`, and `vite build` on every PR.

### M6 — Deploy pipeline

- `wrangler.toml` now defines `[env.staging]` and `[env.production]` with per-env D1 / R2 / KV bindings so state is never shared across envs.
- `.github/workflows/deploy.yml` rewritten as a four-stage pipeline: **gate → resolve-env → deploy → smoke-test**.
  - Push to `main` → auto-deploy to **staging**.
  - Push tag `v*.*.*` → deploy to **production**.
  - `workflow_dispatch` input → deploy to the chosen env manually.
- The `gate` job runs the same checks as `ci.yml` (svelte-check + lint + build) so PRs and deploys can't disagree.
- `deploy` attaches to a GitHub Environment of the same name — add required-reviewer protection on `production` under Settings → Environments to gate prod behind an approval.
- D1 migrations apply with `--env <target>` so each env's schema is bumped independently.
- `smoke-test` curls the public URL (from repo Variables `STAGING_PUBLIC_URL` / `PRODUCTION_PUBLIC_URL`) up to 6× with 10 s backoff; treats 2xx/3xx/503 as healthy.
- `docs/DEPLOYMENT.md` now documents the full promotion flow, required secrets/variables, and per-env provisioning steps.

### M7 — Editor UX

- New `$lib/components/editor/MarkdownEditor.svelte` drop-in replaces the bare article body `<textarea>` in both `new` and `[id]` routes for EN and TH.
- Toolbar: bold, italic, H1/H2, link, media-insert, bulleted/numbered lists, inline code, blockquote.
- Three view modes (Write / Split / Preview) — split shows live `marked`-rendered HTML in a `prose` pane next to the editor; `@tailwindcss/typography` plugin enabled via `@plugin` in `app.css`.
- Keyboard shortcuts: ⌘B (bold), ⌘I (italic), ⌘K (link).
- `MediaPicker` modal lazy-loads `GET /api/media`, renders a thumbnail grid, and inserts `![alt](/api/media/:id)` for images or `[name](/api/media/:id)` for other types at the cursor.
- Autosave: debounced write to `localStorage[khaopad:draft:article:<scope>:<field>]`; on re-open, compares against the seeded value and offers a restore banner if different. Cleared after a successful save via the parent's `use:enhance` callback.
- i18n: 22 new Paraglide keys (EN + TH) covering toolbar labels, modes, picker copy, and the parameterized draft-available banner.

### v1.1 — Path-prefix routing, shadcn reskin, scope tightening

A consolidation release: ship the architectural change everyone needs, modernize the admin shell, fix a class of D1 + Better Auth bugs, and cut the unimplemented "Mode B" GitHub backend that had been hanging around since M1.

**Routing**

- CMS moved from `cms.example.com` subdomain to `/cms/*` path prefix on the same host (#11). Unblocks Cloudflare workers.dev demos, removes `/etc/hosts` editing for local dev, lines up with how Sanity Studio / Strapi / KeystoneJS ship their admin panels.
- `subdomainHook` → `surfaceHook` in `hooks.server.ts`. `event.locals.surface` is the new property; `event.locals.subdomain` kept as a deprecated alias.
- `/` redirects to the visitor's preferred locale (`/en` or `/th`) via cookie / Accept-Language / default precedence (#13). Removes a stale pre-reskin home page that was orphaned at the bare root.
- Single-host wrangler config replaces the `www.` / `cms.` split: one DNS record, one route pattern, no zone gymnastics.

**Admin reskin (PR #12)**

- Hand-rolled collapsible sidebar with localStorage state, lucide icons, role-gated items (Users / Settings hidden from author/editor), active-route highlight that survives nested paths.
- Two-column auth pages on `/cms/login` and `/cms/signup` (brand panel + form on `lg+`, single column on mobile).
- Cookie-based locale toggle in the admin topbar (no URL change). The Paraglide strategy `["url","cookie","baseLocale"]` already does this — `/cms/*` has no `/en` or `/th` URL prefix to match, so the URL strategy falls through to cookie automatically.
- shadcn-style primitives in `$lib/components/ui/`: Button, Input, Label, Card (+ Header/Title/Description/Content/Footer), Separator, Badge, Avatar with initials fallback.
- oklch palette + IBM Plex Sans Thai. `.dark` block in `app.css` for a future dark-mode toggle.

**Auth resilience**

- D1 + Date-binding fix (#14). Better Auth's adapter passed JS `Date` objects directly to D1, which only accepts string/number/boolean/null/Uint8Array — every signup crashed with `D1_TYPE_ERROR`. The fix wraps the D1 driver in `createAuth` so `prepare(sql).bind(...args)` swaps Dates for ISO strings before Cloudflare's binding code sees them. (`databaseHooks` don't help here — Better Auth's transform layer runs after hooks and converts ISO strings _back_ to Dates if the field type is `"date"`.)
- `auth.api.signUpEmail` now receives `request.headers` so the auto-sign-in path has a request context for the session cookie write.
- `auth.api.getSession` is wrapped in try/catch in the auth hook — a malformed session cookie no longer turns every page into a 500.

**Scope tightening (PR #17)**

- Removed the never-shipped GitHub-backed "Mode B" content storage entirely (`src/lib/server/content/providers/github.ts`, `CONTENT_MODE` env var, `GITHUB_*` config knobs, `.github/workflows/content-sync.yml`). Doubled the bug surface for hypothetical users; broke at media (R2 isn't versioned); confused the product pitch. The `ContentProvider` interface stays as a seam for tests.
- Sidebar entries for `/cms/users` and `/cms/settings` removed (#16) — the routes were referenced but had no `+page.svelte`. Re-added in v1.2 (#20).

**Net effect:** ~500 lines deleted, 6 PRs merged (#11–#13, #14–#16, #17). README, ARCHITECTURE, CONTENT-MODEL, MIGRATING, CLAUDE.md all updated to match. Live demo at `khaopad-example.codustry.workers.dev` runs all of v1.1 end-to-end.

### v1.2 — User & settings management (PR #20)

Closes the two sidebar 404s left by v1.1. Pure UI work on top of infrastructure that was already in place: the `users` table from M3, the `site_settings` table from M2, and the `ContentProvider.getSettings`/`updateSettings` methods that have existed in the interface since day one.

**`/cms/users`** — list view with avatar, role badge, joined date.

- Inline per-row role change with a dropdown.
- Last-super-admin demotion blocked with a clear error.
- Plain admins can manage editors and authors but not other admins or super_admins.
- Hard-delete with confirm; sessions and accounts cascade via existing FK rules; articles authored by the user block the delete with a surfaced "reassign first" message instead of a 500.
- Cannot change your own role or delete yourself.
- Every role change and deletion writes an `audit_log` row (best-effort, swallowed if the table isn't available so it never fails the action).
- Invite-link card surfaces the existing `/cms/signup` flow as the MVP. A real token-based invite system is deferred to a later release.

**`/cms/settings`** — form for `siteName`, `defaultLocale`, `supportedLocales`, `cdnBaseUrl`. Validates `defaultLocale` is in `supportedLocales`; site name required; at least one locale required. Reads from + writes to the existing `site_settings` table via `ContentProvider`.

**Permission helper** — new `canManageUser(actor, target)` centralizes three rules (no self-management, super_admin protection, admin-can't-touch-admin). Both server actions and the UI use it, so the buttons that appear match the actions that succeed.

**Sidebar** — `/cms/users` and `/cms/settings` re-added to the "Admin" group, role-gated to `super_admin` and `admin`.

**i18n** — 38 new Paraglide keys (EN + TH) covering role labels, field labels, help text, error strings, invite-card copy.

### v1.3 — Token invitations + audit log + scheduled publishing (PR #24)

Three features in one PR — they share the audit-log infrastructure and the admin-shell layout, and shipping separately would create review churn.

**Token-based invitations** replaces the v1.2 placeholder card on `/cms/users`. New `invitations` table (Drizzle migration 0001) with `email`, `role`, `token`, `expiresAt`, `acceptedAt`. The token is a random base64url string (~128 bits of entropy); the URL itself is the bearer credential — presence + unconsumed + not-expired = valid. Helpers in `$lib/server/invitations/` cover create / find / consume (atomic via a where-clause guard on `acceptedAt IS NULL`, so a race between two browsers leaves exactly one winner) / revoke / list. The `/cms/users` page now has a real form: pick role, generate, copy with one click, see all outstanding invites, revoke any of them. `/cms/invite/[token]` is a full-bleed accept page with granular error states for invalid / consumed / expired tokens; on POST it runs Better Auth `signUpEmail`, sets the new user's role from the invitation, marks the invitation consumed, and redirects to `/cms/login?invited=1`. The `(cms)` layout gate was widened to allow `/cms/invite/*` without auth. Default TTL: 7 days.

**Audit-log viewer page** — extracted v1.2's `logAudit` helper to `$lib/server/audit/` with a typed `AuditAction` union covering every action the project logs (article.create / article.publish / category.update / tag.delete / media.delete / settings.update / invitation.create / invitation.accept / etc.). Best-effort writes — wrapped in try/catch so a missing table or transient D1 error never breaks the primary action the user cared about. Audit hooks added throughout: articles (create / update / publish / unpublish / delete), categories (create / update / delete), tags (create / update / delete), media (delete), settings (update), invitations (create / accept / revoke). The `/cms/audit` page (admin+ only) is paginated 50/page, shows actor avatar + name + email, action badge color-coded by verb (create/accept = primary, delete/revoke = destructive, else secondary), entity reference, timestamp, and an expandable JSON metadata block. Left-joins `users` so deleted-user rows still render gracefully. Sidebar gets a new "Audit log" entry in the Admin group.

**Scheduled publishing** — new `ArticleFilter.onlyPublished?: boolean` flag (default `false` so the CMS sees everything; public reads opt in). When set, the D1 provider adds `(publishedAt IS NULL OR publishedAt <= now)` to the WHERE clause — rows with no `publishedAt` slip through (treated as "publish immediately when status is 'published'"). Public blog index passes the flag; the `[slug]` page adds the same date check after the status check (a published article with a future `publishedAt` 404s). `ArticleForm.svelte` gets a `<input type="datetime-local">` next to the status select that pre-fills from `existing.publishedAt` and shows a "⏱ Scheduled for {when}" notice when status is published AND the date is in the future. Save action: explicit datetime from the form wins; otherwise the existing fallback rules apply (published → now, draft → null, archived → keep existing).

**i18n** — 22 new Paraglide keys (EN + TH).

### v1.4 — Full-text search (PR #26)

SQLite FTS5 virtual table over the per-locale `article_localizations` rows. Drizzle doesn't model virtual tables, so the migration (`drizzle/0002_fts5_articles.sql`) is hand-written: an `articles_fts` external-content table indexing `title`, `excerpt`, `body`, with `articleId` and `locale` carried as unindexed columns; tokenizer `unicode61 remove_diacritics 2` so Thai content tokenizes sensibly. Three `AFTER INSERT/UPDATE/DELETE` triggers on `article_localizations` keep the index in sync transparently — application code never touches FTS directly. A backfill at the end of the migration seeds the index from existing rows.

`ContentProvider.searchArticles(query, opts)` returns `SearchHit[]` joined against `articles` so the result respects status + scheduled publishing (`onlyPublished` flag is plumbed through). Query handling defaults to a quoted phrase match for safety, but lets advanced users pass FTS5 syntax (`AND` / `OR` / `NOT` / `NEAR` / parens / quotes / wildcards) by detecting those tokens and skipping the auto-quote. Public `/blog?q=` adds a search form to the index page; CMS articles list reuses the same flag.

**i18n** — 4 new `blog_search_*` keys (EN + TH).

### v1.5 — Content versioning (PR #27)

Per-article revision history with diff and restore. New `article_versions` table (Drizzle migration 0003) stores `articleId`, `locale`, monotonic `version` per `(articleId, locale)`, plus the snapshotted `title`, `excerpt`, `body`, `seoTitle`, `seoDescription`, `createdBy` (FK to `users`, `ON DELETE SET NULL` so deleted authors don't blow up the timeline), and `createdAt`. CASCADE from `articles` so deleting an article cleans up its history.

Snapshots are taken at the application layer in `D1ContentProvider` — only for the locales actually present in the create / update payload, never phantom snapshots for untouched locales. `actorId` is now part of `ArticleCreateInput` / `ArticleUpdateInput` so SQLite triggers don't have to guess at request context. New methods: `listArticleVersions`, `getArticleVersion`. LCS-via-DP line diff lives at `$lib/server/content/diff.ts` (no external dep — `diff-match-patch` was overkill for what's effectively `git diff`).

UI: `/cms/articles/[id]/history` is a timeline with batched actor lookups (one query for all `createdBy` IDs across the page). `/cms/articles/[id]/history/[versionId]` renders title / excerpt diffs as before/after blocks and the body as a per-line +/– list. Restore writes a fresh update through the normal path — which itself snapshots the now-replaced version — so undo is just "restore the previous version again." The action also writes an audit-log entry with `restoredFrom` / `restoredVersion` metadata.

**i18n** — 11 new `cms_history_*` keys (EN + TH).

## Pending

### Vision — what comes after v1.5

Through v1.5 we have a complete content layer: write, schedule, search, version. That's table stakes. The bigger thesis is that Khao Pad is the **driver of a non-ecommerce website** — meaning a site owner installs Khao Pad and gets the content layer **plus** the surrounding machinery a real website needs. The five pillars below organize that machinery; each pending milestone delivers a slice of one.

1. **Discoverability (SEO).** A site nobody finds is a site that doesn't exist. Per-page meta, sitemap, robots, structured data, hreflang, feeds, redirects.
2. **Insight (analytics).** Editors need to know what's working. Privacy-friendly page views, top content, search-term performance, editor metrics.
3. **Information architecture.** Articles aren't the whole site. Pages, navigation menus, hierarchy, asset organization.
4. **Performance & trust.** Responsive images, cache control, custom error pages, cookie consent.
5. **Engagement & growth.** Forms, newsletter, comments, webhooks, integrations.

The release plan below picks the 80/20 slice from each pillar in turn. v1.6 → v2.0 is roughly four months of focused work.

### v1.6 — SEO foundations (pending)

The biggest single gap: `seoTitle` / `seoDescription` are stored on `article_localizations` but never rendered into the public `<head>`. Visitors and search engines see whatever the markdown title is. Fix that, then add the rest of the on-page SEO surface.

**Per-page meta** — A reusable `<Seo>` Svelte component that lives in `(www)/+layout.svelte` and reads from a `pageSeo` store populated by each page's `+page.server.ts` load. Renders `<title>`, `<meta name="description">`, `<link rel="canonical">`, `og:title` / `og:description` / `og:image` / `og:type` / `og:locale`, Twitter Card tags, and `<link rel="alternate" hreflang="...">` pairs for the EN/TH bilingual surface. Each article page passes its own SEO record; the layout supplies sensible defaults from `site_settings`.

**Sitemap** — `/sitemap.xml` index that points to `/sitemap-en.xml` and `/sitemap-th.xml`. Each per-locale sitemap lists every published article (respecting scheduled publishing) with `<loc>`, `<lastmod>` from `updatedAt`, and `<xhtml:link rel="alternate">` hreflang siblings. Streams from D1 — no caching needed at typical CMS scale; revisit if a single instance ever holds 50k+ URLs.

**robots.txt** — Per-environment. Production allows all; staging emits `Disallow: /` to keep the preview off Google. Driven by a new `WORKERS_ENV` binding so the file changes without code.

**JSON-LD structured data** — `Article` schema on each blog post (headline, datePublished, dateModified, author, image, articleBody snippet); `BreadcrumbList` on category/tag landing pages; `WebSite` + `Organization` on the site root. All emitted via the `<Seo>` component as a single `<script type="application/ld+json">` block per page.

**RSS / Atom feed** — `/feed.xml` (default locale) and `/feed-{locale}.xml` per locale. 50 most recent published articles with full content. Also surfaces in the `<head>` as `<link rel="alternate" type="application/rss+xml">` so feed readers auto-discover.

**Slug redirects** — A new `slug_redirects` table (`oldSlug`, `newSlug`, `createdAt`). When `updateArticle({ slug })` rewrites a slug, write a redirect row automatically. The public `/blog/[slug]` route checks for a redirect and 301s if found. Keeps backlinks alive across slug edits.

**SEO scoring hint** — On the article edit page, show a soft check next to the SEO fields: title length 30–60 chars (good), description 70–160 chars (good), missing description (warn), title exceeds 60 (warn). No hard validation — purely advisory.

### v1.7 — Pages, navigation, and asset organization (pending)

A blog isn't a website. A website needs static pages (About, Contact, Privacy) and someone has to manage the menu that links to them.

**Pages** — A new `pages` table separate from `articles`: id, slug (per-locale optional), `parentId` for nesting, `template` (default | landing | legal), `publishedAt`, `localizations` (title, body, seoTitle, seoDescription). Routed at `/(www)/[locale]/[...slug]` with a catch-all to support nested slugs like `/about/team`. Reuses the markdown editor and SEO machinery from v1.6.

**Navigation manager** — `/cms/navigation` admin page. Two named menus by default (`primary`, `footer`); each menu is an ordered tree of items. Each item is either an internal link (to an article, category, page) or a custom URL + label. Stored in a `navigation_menus` table + `navigation_items` join. Public `<SiteHeader>` and `<SiteFooter>` components read the menu from `locals.navigation` (populated by a hook).

**Media folders** — Answer to "can I organize media into folders?" Yes. New `parentId` column on `media` referencing itself, plus a `media_folders` table (id, name, parentId). The `/cms/media` page gets a left tree pane with create/rename/delete folder actions, drag-to-move on rows. Filter by folder via a `folderId` filter on `media.list()`. Backwards-compatible: existing rows have `parentId = null` and live at the root.

**Reusable content blocks** — A `content_blocks` table (id, key, locale, body) for snippets reused across pages (CTA, author bio, footer disclaimer). Markdown editor gets a `{{block:cta-newsletter}}` shortcode that's expanded server-side at render time.

### v1.8 — Analytics and insight (pending)

**Page-view counter** — Edge-side, privacy-respecting. New `analytics_events` table on D1 with a `Cloudflare Worker` middleware that increments a counter per `(path, day)` on every public page request, no IP/UA stored. Aggregates via the queue worker so the request path stays sub-millisecond. Optional integration with Cloudflare Web Analytics for the deeper view (referrers, devices, countries) — opt-in via a setting.

**Editor analytics on the dashboard** — Top 10 articles by views (last 30 days), top search terms (last 30 days, from `searchArticles` calls), draft-to-publish median time, articles updated this week. Sourced from `analytics_events` + `audit_log`. Adds a "Performance" card to the dashboard.

**Per-article analytics** — On each article edit page, a sparkline of the last 30 days of views, pulled from `analytics_events`.

**Search-term insights** — Log every public-facing `searchArticles` query (anonymized, just the term + date) into a new `search_log` table. Dashboard tile: "Search terms with no results" — the high-signal list of content gaps to fill.

### v1.9 — Performance and trust (pending)

**Responsive images** — Cloudflare Images binding. The R2-stored original is the source; the `<img>` tag emits a `<picture>` block with `srcset` for `320w`, `640w`, `1024w`, `1920w` widths and `sizes` defaults. Falls back to the raw R2 URL if the binding isn't configured.

**Cache control** — Explicit `Cache-Control` on each public route: `public, max-age=60, s-maxage=300, stale-while-revalidate=86400` for the blog list; longer for individual articles; `no-store` for `/cms/*`. Documented in `docs/PLATFORM-NOTES.md`.

**Custom 404 / 500** — Branded error pages with: a search box (uses v1.4 FTS), the most-recent 5 articles, and a link home. Lives in `(www)/+error.svelte`.

**Cookie consent** — Minimal banner (Accept / Decline) that gates analytics / OG-image hotlinking; stored in a first-party cookie. Required if any v1.8 analytics get turned on for a public site.

**Health endpoint** — `/api/health` returns 200 with a JSON body listing D1 reachability, R2 reachability, KV reachability, last successful migration. Used by the smoke-test job in `deploy.yml`.

### v2.0 — Engagement and growth (pending)

**Forms** — A new `forms` table (id, name, fields-as-JSON) and `form_submissions` table. CMS editor for fields (text, email, textarea, checkbox). Public submission endpoint with built-in honeypot + rate limit. Submissions land in the CMS for review; optional webhook on submit.

**Newsletter** — Subscriber list (`subscribers` table: email, locale, confirmedAt, unsubscribedAt, source). Opt-in via a form on the public site with double-confirm email. CMS digest job pulls the last week's published articles and sends a templated email via Resend / Cloudflare Email Routing. Compliance: clear unsubscribe link in every email, audit log of subscribe/unsubscribe events.

**Comments** — Per-article comments with name + email, queued for moderation by default. CMS moderation queue at `/cms/comments`. Akismet-style spam filter is out of scope; rate limit + honeypot is the v2.0 floor. Optional: anchor in `<article>` body.

**Webhooks** — `/cms/webhooks` lets admins register URLs to ping on `article.publish`, `article.unpublish`, `form.submit`, `subscriber.confirm`. Signed with HMAC-SHA256 using a per-webhook secret. Retried with exponential backoff up to 5×.

**Public REST API** — `/api/public/*` read-only endpoints (articles, categories, tags, pages) for headless consumers. API-key auth via a new `api_keys` table; per-key scopes (read articles only, etc.). Rate-limited per key.

### Backlog — bigger ideas, not committed

These are real, but each is large enough to deserve its own design pass. Listed for transparency, not commitment.

- **OAuth providers** (Google, GitHub) for multi-admin sites that don't want to manage passwords.
- **Block-based editor** — replace the markdown body with a Tiptap or ProseMirror tree of blocks (hero, callout, gallery, embed). Loses the "everything is markdown" simplicity; gains rich layout. Big call.
- **AI-assisted authoring** — outline generation, alt-text suggestion, SEO-description writing, machine-translation for the EN→TH gap. Requires a model binding choice (Workers AI? OpenAI?).
- **Multi-site / workspaces** — one Khao Pad instance hosting multiple independent sites. Schema isolation via a `siteId` column on every table.
- **A/B testing** — per-page hero variants with a randomized 50/50 cookie. Needs the analytics layer (v1.8) as a prerequisite.
- **Member-only content** — gated articles behind a paid subscription via Stripe. Shifts Khao Pad toward Substack territory; explicit non-goal for now.
